// Phase 4.2 — execution worker.
//
// Polls every WORKER_TICK_MS for users opted-in (rotation_authority active,
// vault initialized) and executes optimal rotations. Replace the polling loop
// with a Helius epoch-boundary webhook in production (Phase 1.2).
//
// The Jupiter /swap-instructions integration is sketched but left TODO at the
// `buildJupiterIx` call — that endpoint returns the raw instruction (programs,
// accounts, data) which is then forwarded to execute_rotation via remaining_accounts.

import fs from "node:fs";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { eq, isNotNull } from "drizzle-orm";
import { env } from "../env.ts";
import { getDb, closeDb } from "../db/client.ts";
import { users, type User } from "../db/schema.ts";
import { LSTS, TRACKED_LSTS, type LstSymbol } from "../lsts.ts";
import { fetchSnapshot } from "../sanctum.ts";
import { rankRotations } from "../calc.ts";
import { fetchLstHoldings } from "../balances.ts";
import {
  deriveVault,
  ixExecuteRotation,
  STAKE_ROTATOR_PROGRAM_ID,
} from "../program.ts";

const TICK_MS = Number(process.env.WORKER_TICK_MS ?? "300000"); // 5 min default

function loadBotKeypair(): Keypair {
  const path = process.env.BOT_KEYPAIR_PATH;
  if (!path) throw new Error("missing BOT_KEYPAIR_PATH");
  const raw = JSON.parse(fs.readFileSync(path, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

interface JupiterSwapIx {
  programId: PublicKey;
  accounts: Array<{ pubkey: PublicKey; isSigner: boolean; isWritable: boolean }>;
  data: Uint8Array;
}

async function buildJupiterIx(
  _from: LstSymbol,
  _to: LstSymbol,
  _amountBaseUnits: bigint,
  _vaultPda: PublicKey,
  _slippageBps: number,
): Promise<JupiterSwapIx> {
  // TODO: POST to https://lite-api.jup.ag/swap/v1/swap-instructions with
  //   { quoteResponse, userPublicKey: vaultPda.toBase58(), wrapAndUnwrapSol: false }
  // Parse the returned `swapInstruction` (programs/accounts/data),
  // plus `addressLookupTableAddresses`, `setupInstructions`, `cleanupInstruction`.
  // Forward only the swapInstruction's accounts as remaining_accounts.
  throw new Error("buildJupiterIx not implemented — wire Jupiter /swap-instructions");
}

async function processUser(conn: Connection, bot: Keypair, user: User) {
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

  const snapshot = await fetchSnapshot(TRACKED_LSTS);
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

  const minOut = (top.amountBaseUnits * 9950n) / 10000n; // 0.5% slippage on input units
  let swap: JupiterSwapIx;
  try {
    swap = await buildJupiterIx(top.symbol, rec.dest, top.amountBaseUnits, vaultPda, 50);
  } catch (err) {
    console.error(`user ${user.telegramId}: swap build failed:`, (err as Error).message);
    return;
  }

  const sourceMint = new PublicKey(LSTS[top.symbol].mint);
  const destMint = new PublicKey(LSTS[rec.dest].mint);
  // Vault ATAs are derived off-chain by the bot; for legacy SPL Token, the standard ATA program is used.
  // Compute them via getAssociatedTokenAddressSync (allowOwnerOffCurve = true since vaultPda is a PDA).
  const { getAssociatedTokenAddressSync } = await import("@solana/spl-token").catch(() => ({
    getAssociatedTokenAddressSync: null as unknown as never,
  }));
  if (typeof getAssociatedTokenAddressSync !== "function") {
    throw new Error("worker requires @solana/spl-token (pnpm add @solana/spl-token)");
  }
  const vaultSrc = getAssociatedTokenAddressSync(sourceMint, vaultPda, true);
  const vaultDst = getAssociatedTokenAddressSync(destMint, vaultPda, true);

  const ix = ixExecuteRotation(
    owner,
    bot.publicKey,
    sourceMint,
    destMint,
    vaultSrc,
    vaultDst,
    swap.data,
    minOut,
    swap.accounts,
  );

  const tx = new Transaction().add(ix);
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = bot.publicKey;
  tx.sign(bot);
  try {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    console.log(`user ${user.telegramId}: rotation sent ${top.symbol}→${rec.dest} sig=${sig}`);
  } catch (err) {
    console.error(`user ${user.telegramId}: send failed`, (err as Error).message);
  }
}

async function tick(conn: Connection, bot: Keypair) {
  const db = getDb();
  const optIns = await db.select().from(users).where(isNotNull(users.walletPubkey));
  console.log(`tick: ${optIns.length} users`);
  for (const u of optIns) {
    try {
      await processUser(conn, bot, u);
    } catch (err) {
      console.error(`user ${u.telegramId}: processing error`, err);
    }
  }
}

async function main() {
  const conn = new Connection(env.heliusRpcUrl(), "confirmed");
  const bot = loadBotKeypair();
  console.log(`worker starting (bot=${bot.publicKey.toBase58()}, tick=${TICK_MS}ms)`);

  const shutdown = async () => {
    console.log("worker shutting down...");
    await closeDb();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // Run once immediately, then on interval.
  await tick(conn, bot).catch((e) => console.error("tick error:", e));
  // Suppress unused-eq lint by referencing it (used by future per-user query refinements).
  void eq;
  setInterval(() => {
    tick(conn, bot).catch((e) => console.error("tick error:", e));
  }, TICK_MS);
}

main().catch((err) => {
  console.error("worker failed:", err);
  process.exit(1);
});
