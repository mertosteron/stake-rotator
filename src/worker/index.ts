// Phase 4.2 — execution worker.
//
// Polls every WORKER_TICK_MS for users opted-in (rotation_authority active,
// vault initialized) and executes optimal rotations. Replace the polling loop
// with a Helius epoch-boundary webhook in production (Phase 1.2).

import fs from "node:fs";
import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { isNotNull } from "drizzle-orm";
import { env } from "../env.ts";
import { getDb, closeDb } from "../db/client.ts";
import { users, type User } from "../db/schema.ts";
import { LSTS, TRACKED_LSTS, type LstSymbol } from "../lsts.ts";
import { fetchSnapshot, type LstSnapshot } from "../sanctum.ts";
import { rankRotations } from "../calc.ts";
import { fetchLstHoldings } from "../balances.ts";
import { captureApySnapshot } from "../earnings_tracker.ts";
import {
  deriveVault,
  ixExecuteRotation,
  JUPITER_V6_PROGRAM_ID,
  STAKE_ROTATOR_PROGRAM_ID,
} from "../program.ts";

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? "300000"); // 5 min default

function loadBotKeypair(): Keypair {
  const path = process.env.BOT_KEYPAIR_PATH;
  if (!path) throw new Error("missing BOT_KEYPAIR_PATH");
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown;
}

interface JupiterRawInstruction {
  programId: string;
  accounts: Array<{ pubkey: string; isSigner: boolean; isWritable: boolean }>;
  data: string;
}

interface SwapInstructionsResponse {
  computeBudgetInstructions?: JupiterRawInstruction[];
  setupInstructions?: JupiterRawInstruction[];
  swapInstruction: JupiterRawInstruction;
  cleanupInstruction?: JupiterRawInstruction | null;
  tokenLedgerInstruction?: JupiterRawInstruction | null;
  addressLookupTableAddresses?: string[];
}

interface JupiterSwapIx {
  programId: PublicKey;
  accounts: Array<{
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }>;
  data: Uint8Array;
  minOutAmount: bigint;
  computeBudgetInstructions: TransactionInstruction[];
  addressLookupTableAddresses: PublicKey[];
}

function decodeInstruction(raw: JupiterRawInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(raw.programId),
    keys: raw.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(raw.data, "base64"),
  });
}

async function fetchJupiterQuote(
  from: LstSymbol,
  to: LstSymbol,
  amountBaseUnits: bigint,
  slippageBps: number,
): Promise<QuoteResponse> {
  const params = new URLSearchParams({
    inputMint: LSTS[from].mint,
    outputMint: LSTS[to].mint,
    amount: amountBaseUnits.toString(),
    slippageBps: slippageBps.toString(),
  });
  const res = await fetch(`${env.jupiterApiBase()}/quote?${params}`);
  if (!res.ok) {
    throw new Error(`Jupiter quote ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as QuoteResponse;
}

async function buildJupiterIx(
  from: LstSymbol,
  to: LstSymbol,
  amountBaseUnits: bigint,
  vaultPda: PublicKey,
  slippageBps: number,
): Promise<JupiterSwapIx> {
  const quote = await fetchJupiterQuote(from, to, amountBaseUnits, slippageBps);
  const res = await fetch(`${env.jupiterApiBase()}/swap-instructions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey: vaultPda.toBase58(),
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Jupiter swap-instructions ${res.status} ${res.statusText} ${text}`,
    );
  }

  const data = (await res.json()) as SwapInstructionsResponse;
  if (data.tokenLedgerInstruction) {
    throw new Error(
      "Jupiter returned tokenLedgerInstruction; worker does not support token ledger swaps",
    );
  }
  if (data.cleanupInstruction) {
    throw new Error(
      "Jupiter returned cleanupInstruction; worker expected no cleanup with wrapAndUnwrapSol=false",
    );
  }
  if (data.setupInstructions && data.setupInstructions.length > 0) {
    throw new Error(
      "Jupiter returned setupInstructions; ensure vault ATAs exist before requesting swap instructions",
    );
  }
  const addressLookupTableAddresses = (
    data.addressLookupTableAddresses ?? []
  ).map((address) => new PublicKey(address));

  const swapIx = decodeInstruction(data.swapInstruction);
  if (!swapIx.programId.equals(JUPITER_V6_PROGRAM_ID)) {
    throw new Error(
      `Jupiter swap instruction used unexpected program ${swapIx.programId.toBase58()}`,
    );
  }
  return {
    programId: swapIx.programId,
    accounts: swapIx.keys,
    data: swapIx.data,
    minOutAmount: BigInt(quote.otherAmountThreshold),
    computeBudgetInstructions: (data.computeBudgetInstructions ?? []).map(
      decodeInstruction,
    ),
    addressLookupTableAddresses,
  };
}

async function fetchLookupTables(
  conn: Connection,
  addresses: PublicKey[],
): Promise<AddressLookupTableAccount[]> {
  if (addresses.length === 0) return [];
  const tables = await Promise.all(
    addresses.map(async (address) => {
      const res = await conn.getAddressLookupTable(address);
      if (!res.value) {
        throw new Error(
          `address lookup table not found: ${address.toBase58()}`,
        );
      }
      return res.value;
    }),
  );
  return tables;
}

async function ensureAta(
  conn: Connection,
  bot: Keypair,
  mint: PublicKey,
  owner: PublicKey,
): Promise<PublicKey> {
  const { createAssociatedTokenAccountInstruction } =
    await import("@solana/spl-token");
  const address = getAssociatedTokenAddressSync(mint, owner, true);
  const info = await conn.getAccountInfo(address, "confirmed");
  if (info) return address;

  const tx = new Transaction().add(
    createAssociatedTokenAccountInstruction(
      bot.publicKey,
      address,
      owner,
      mint,
    ),
  );
  const { blockhash, lastValidBlockHeight } =
    await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = bot.publicKey;
  tx.sign(bot);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await conn.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed",
  );
  return address;
}

async function processUser(
  conn: Connection,
  bot: Keypair,
  user: User,
  snapshot: LstSnapshot[],
) {
  if (!user.walletPubkey) return;
  const owner = new PublicKey(user.walletPubkey);
  const [vaultPda] = deriveVault(owner);

  const vaultInfo = await conn.getAccountInfo(vaultPda);
  if (!vaultInfo || !vaultInfo.owner.equals(STAKE_ROTATOR_PROGRAM_ID)) {
    return; // user has not initialized their vault on-chain yet
  }

  // For MVP we read holdings of the *vault PDA*, not the user's wallet.
  const holdings = await fetchLstHoldings(vaultPda.toBase58());
  if (holdings.length === 0) return;
  const top = holdings.reduce((a, b) => (a.amount > b.amount ? a : b));

  const bySym = new Map(snapshot.map((s) => [s.symbol, s]));
  const srcSnap = bySym.get(top.symbol);
  if (!srcSnap || srcSnap.solPerLst === null) return;
  const sourceBalanceSol = top.amount * srcSnap.solPerLst;

  const rows = await rankRotations({
    source: top.symbol,
    sourceBalanceSol,
    snapshot,
    paybackDaysMax: user.paybackDaysMax,
  });
  const rec = rows.find((r) => r.recommended);
  if (!rec) return;

  const sourceMint = new PublicKey(LSTS[top.symbol].mint);
  const destMint = new PublicKey(LSTS[rec.dest].mint);
  const vaultSrc = getAssociatedTokenAddressSync(sourceMint, vaultPda, true);
  const vaultDst = await ensureAta(conn, bot, destMint, vaultPda);

  let swap: JupiterSwapIx;
  try {
    swap = await buildJupiterIx(
      top.symbol,
      rec.dest,
      top.amountBaseUnits,
      vaultPda,
      50,
    );
  } catch (err) {
    console.error(
      `user ${user.telegramId}: swap build failed:`,
      (err as Error).message,
    );
    return;
  }

  const ix = ixExecuteRotation(
    owner,
    bot.publicKey,
    sourceMint,
    destMint,
    vaultSrc,
    vaultDst,
    swap.data,
    swap.minOutAmount,
    swap.accounts,
  );

  const instructions = [...swap.computeBudgetInstructions, ix];

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  try {
    const lookupTables = await fetchLookupTables(
      conn,
      swap.addressLookupTableAddresses,
    );
    const message = new TransactionMessage({
      payerKey: bot.publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message(lookupTables);
    const tx = new VersionedTransaction(message);
    tx.sign([bot]);
    const sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
    });
    console.log(
      `user ${user.telegramId}: rotation sent ${top.symbol}→${rec.dest} sig=${sig}`,
    );
  } catch (err) {
    console.error(
      `user ${user.telegramId}: send failed`,
      (err as Error).message,
    );
  }
}

async function tick(conn: Connection, bot: Keypair) {
  const db = getDb();
  const optIns = await db
    .select()
    .from(users)
    .where(isNotNull(users.walletPubkey));
  const snapshot = await fetchSnapshot(TRACKED_LSTS);
  await captureApySnapshot(snapshot).catch((e) =>
    console.error("apy snapshot error:", e),
  );
  console.log(`tick: ${optIns.length} users`);
  for (const u of optIns) {
    try {
      await processUser(conn, bot, u, snapshot);
    } catch (err) {
      console.error(`user ${u.telegramId}: processing error`, err);
    }
  }
}

async function main() {
  const conn = new Connection(env.heliusRpcUrl(), "confirmed");
  const bot = loadBotKeypair();
  console.log(
    `worker starting (bot=${bot.publicKey.toBase58()}, tick=${TICK_MS}ms)`,
  );

  const shutdown = async () => {
    console.log("worker shutting down...");
    await closeDb();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // Run once immediately, then on interval.
  await tick(conn, bot).catch((e) => console.error("tick error:", e));
  setInterval(() => {
    tick(conn, bot).catch((e) => console.error("tick error:", e));
  }, TICK_MS);
}

main().catch((err) => {
  console.error("worker failed:", err);
  process.exit(1);
});
