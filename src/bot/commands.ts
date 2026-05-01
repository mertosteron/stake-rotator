import type { Bot, Context } from "grammy";
import { eq } from "drizzle-orm";
import {
  Connection,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { randomUUID } from "node:crypto";
import { LSTS, TRACKED_LSTS, type LstSymbol } from "../lsts.ts";
import { fetchSnapshot, type LstSnapshot } from "../sanctum.ts";
import { rankRotations, type Rotation } from "../calc.ts";
import { fetchLstHoldings, type LstHolding } from "../balances.ts";
import { buildRotationTx } from "../swap.ts";
import { getDb } from "../db/client.ts";
import { users, type User } from "../db/schema.ts";
import { env } from "../env.ts";
import { registerRotation } from "../actions/server.ts";
import {
  deriveVault,
  ixDepositLst,
  ixInitVault,
  ixRevokeAuthority,
  ixWithdrawLst,
} from "../program.ts";

async function getOrCreateUser(telegramId: bigint): Promise<User> {
  const db = getDb();
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.telegramId, telegramId))
    .limit(1);
  if (existing[0]) return existing[0];
  const inserted = await db.insert(users).values({ telegramId }).returning();
  const row = inserted[0];
  if (!row) throw new Error("failed to create user row");
  return row;
}

async function setWallet(
  telegramId: bigint,
  walletPubkey: string,
): Promise<void> {
  const db = getDb();
  await db
    .insert(users)
    .values({ telegramId, walletPubkey })
    .onConflictDoUpdate({
      target: users.telegramId,
      set: { walletPubkey, updatedAt: new Date() },
    });
}

function isValidPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

function parseLstSymbol(raw: string): LstSymbol | null {
  const match = TRACKED_LSTS.find(
    (s) => s.toLowerCase() === raw.trim().toLowerCase(),
  );
  return match ?? null;
}

function parseUiAmount(raw: string, decimals: number): bigint | null {
  const value = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const [whole, frac = ""] = value.split(".");
  if (!whole || frac.length > decimals) return null;
  return BigInt(whole + frac.padEnd(decimals, "0"));
}

async function buildUserSignedTx(
  owner: PublicKey,
  instructions: TransactionInstruction[],
): Promise<string> {
  const conn = new Connection(env.heliusRpcUrl(), "confirmed");
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction().add(...instructions);
  tx.recentBlockhash = blockhash;
  tx.feePayer = owner;
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

async function replyBase64Tx(
  ctx: Context,
  title: string,
  b64: string,
): Promise<void> {
  await ctx.reply(
    [title, "sign this base64 tx in your wallet:", "```", b64, "```"].join(
      "\n",
    ),
    {
      parse_mode: "Markdown",
    },
  );
}

function pickSource(
  user: User,
  holdings: LstHolding[],
  snapshot: LstSnapshot[],
): { holding: LstHolding; sourceBalanceSol: number } | null {
  if (holdings.length === 0) return null;
  const bySymbol = new Map(snapshot.map((s) => [s.symbol, s]));

  const eligible = holdings.filter((h) => {
    const snap = bySymbol.get(h.symbol);
    return snap && snap.solPerLst !== null && snap.apy !== null;
  });
  if (eligible.length === 0) return null;

  let chosen: LstHolding | undefined;
  if (user.sourceLst) {
    chosen = eligible.find((h) => h.symbol === user.sourceLst);
  }
  if (!chosen) {
    chosen = eligible.reduce<LstHolding | undefined>((best, cur) => {
      const curSnap = bySymbol.get(cur.symbol);
      const bestSnap = best ? bySymbol.get(best.symbol) : undefined;
      if (!curSnap || curSnap.solPerLst === null) return best;
      if (!best || !bestSnap || bestSnap.solPerLst === null) return cur;
      return cur.amount * curSnap.solPerLst > best.amount * bestSnap.solPerLst
        ? cur
        : best;
    }, undefined);
  }
  if (!chosen) return null;
  const snap = bySymbol.get(chosen.symbol);
  if (!snap || snap.solPerLst === null) return null;
  return { holding: chosen, sourceBalanceSol: chosen.amount * snap.solPerLst };
}

function fmtRotation(r: Rotation): string {
  const flag = r.recommended ? "✓" : "•";
  const payback = Number.isFinite(r.paybackDays)
    ? `${r.paybackDays.toFixed(1)}d`
    : "never";
  return `${flag} ${r.source} → ${r.dest}  +${r.apyUpliftPp.toFixed(2)}pp  payback ${payback}  daily +${r.dailyUpliftSol.toFixed(5)} SOL`;
}

export function registerCommands(bot: Bot) {
  bot.command("start", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await getOrCreateUser(BigInt(tgId));
    await ctx.reply(
      [
        "Stake Rotator — non-custodial LST auto-rotation.",
        "",
        "Commands:",
        "/bind_wallet <pubkey> — link your Solana wallet (read-only)",
        "/status — show bound wallet and LST holdings",
        "/init_vault [perf_fee_bps_max] — create your non-custodial vault",
        "/deposit <LST> <amount> — move LST into your vault",
        "/withdraw <LST> <amount> — move LST back to your wallet",
        "/recommend — show best rotation candidate",
        "/rotate — build the rotation transaction",
      ].join("\n"),
    );
  });

  bot.command("bind_wallet", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply("usage: /bind_wallet <solana-pubkey>");
      return;
    }
    if (!isValidPubkey(arg)) {
      await ctx.reply(`invalid pubkey: ${arg}`);
      return;
    }
    await setWallet(BigInt(tgId), arg);
    await ctx.reply(`bound wallet ${arg}`);
  });

  bot.command("status", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply("no wallet bound. use /bind_wallet <pubkey>.");
      return;
    }
    const [holdings, snapshot] = await Promise.all([
      fetchLstHoldings(user.walletPubkey),
      fetchSnapshot(TRACKED_LSTS),
    ]);
    if (holdings.length === 0) {
      await ctx.reply(
        `wallet: ${user.walletPubkey}\nno tracked LST holdings (${TRACKED_LSTS.join(", ")})`,
      );
      return;
    }
    const bySym = new Map(snapshot.map((s) => [s.symbol, s]));
    const lines = [`wallet: ${user.walletPubkey}`, "holdings:"];
    let totalSol = 0;
    for (const h of holdings) {
      const snap = bySym.get(h.symbol);
      const valueSol = snap?.solPerLst ? h.amount * snap.solPerLst : null;
      const apy =
        snap?.apy != null ? `${(snap.apy * 100).toFixed(2)}% APY` : "n/a APY";
      lines.push(
        `  ${h.symbol}: ${h.amount.toFixed(4)}  (${valueSol === null ? "?" : valueSol.toFixed(4)} SOL, ${apy})`,
      );
      if (valueSol !== null) totalSol += valueSol;
    }
    lines.push(`total: ${totalSol.toFixed(4)} SOL`);
    lines.push(
      `payback ≤ ${user.paybackDaysMax}d  source ${user.sourceLst ?? "auto"}`,
    );
    await ctx.reply(lines.join("\n"));
  });

  bot.command("init_vault", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply("no wallet bound. use /bind_wallet <pubkey>.");
      return;
    }

    const rawFee = ctx.match.trim();
    const perfFeeBpsMax = rawFee ? Number(rawFee) : 250;
    if (
      !Number.isInteger(perfFeeBpsMax) ||
      perfFeeBpsMax < 0 ||
      perfFeeBpsMax > 2000
    ) {
      await ctx.reply(
        "usage: /init_vault [perf_fee_bps_max], range 0..2000 (default 250)",
      );
      return;
    }

    const owner = new PublicKey(user.walletPubkey);
    const rotationAuthority = new PublicKey(env.rotationAuthorityPubkey());
    const b64 = await buildUserSignedTx(owner, [
      ixInitVault(owner, rotationAuthority, perfFeeBpsMax),
    ]);
    await replyBase64Tx(
      ctx,
      `init vault — rotation authority ${rotationAuthority.toBase58()}, max perf fee ${perfFeeBpsMax} bps`,
      b64,
    );
  });

  bot.command("deposit", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply("no wallet bound. use /bind_wallet <pubkey>.");
      return;
    }

    const [symbolRaw, amountRaw] = ctx.match.trim().split(/\s+/);
    const symbol = symbolRaw ? parseLstSymbol(symbolRaw) : null;
    if (!symbol || !amountRaw) {
      await ctx.reply(`usage: /deposit <${TRACKED_LSTS.join("|")}> <amount>`);
      return;
    }
    const meta = LSTS[symbol];
    const amount = parseUiAmount(amountRaw, meta.decimals);
    if (!amount || amount <= 0n) {
      await ctx.reply(`invalid amount for ${symbol}: ${amountRaw}`);
      return;
    }

    const owner = new PublicKey(user.walletPubkey);
    const [vault] = deriveVault(owner);
    const mint = new PublicKey(meta.mint);
    const ownerAta = getAssociatedTokenAddressSync(mint, owner);
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
    const b64 = await buildUserSignedTx(owner, [
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        vaultAta,
        vault,
        mint,
      ),
      ixDepositLst(owner, mint, ownerAta, vaultAta, amount),
    ]);
    await replyBase64Tx(
      ctx,
      `deposit ${amountRaw} ${symbol} into vault ${vault.toBase58()}`,
      b64,
    );
  });

  bot.command("withdraw", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply("no wallet bound. use /bind_wallet <pubkey>.");
      return;
    }

    const [symbolRaw, amountRaw] = ctx.match.trim().split(/\s+/);
    const symbol = symbolRaw ? parseLstSymbol(symbolRaw) : null;
    if (!symbol || !amountRaw) {
      await ctx.reply(`usage: /withdraw <${TRACKED_LSTS.join("|")}> <amount>`);
      return;
    }
    const meta = LSTS[symbol];
    const amount = parseUiAmount(amountRaw, meta.decimals);
    if (!amount || amount <= 0n) {
      await ctx.reply(`invalid amount for ${symbol}: ${amountRaw}`);
      return;
    }

    const owner = new PublicKey(user.walletPubkey);
    const [vault] = deriveVault(owner);
    const mint = new PublicKey(meta.mint);
    const ownerAta = getAssociatedTokenAddressSync(mint, owner);
    const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
    const b64 = await buildUserSignedTx(owner, [
      createAssociatedTokenAccountIdempotentInstruction(
        owner,
        ownerAta,
        owner,
        mint,
      ),
      ixWithdrawLst(owner, mint, ownerAta, vaultAta, amount),
    ]);
    await replyBase64Tx(
      ctx,
      `withdraw ${amountRaw} ${symbol} from vault ${vault.toBase58()}`,
      b64,
    );
  });

  bot.command("recommend", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply("no wallet bound. use /bind_wallet <pubkey>.");
      return;
    }
    const [holdings, snapshot] = await Promise.all([
      fetchLstHoldings(user.walletPubkey),
      fetchSnapshot(TRACKED_LSTS),
    ]);
    const picked = pickSource(user, holdings, snapshot);
    if (!picked) {
      await ctx.reply("no eligible LST holdings to rotate.");
      return;
    }
    const rows = await rankRotations({
      source: picked.holding.symbol,
      sourceBalanceSol: picked.sourceBalanceSol,
      snapshot,
      paybackDaysMax: user.paybackDaysMax,
    });
    if (rows.length === 0) {
      await ctx.reply("no rotation candidates available.");
      return;
    }
    const top = rows.slice(0, 3);
    const header = `source ${picked.holding.symbol} (${picked.sourceBalanceSol.toFixed(4)} SOL)  payback ≤ ${user.paybackDaysMax}d`;
    const recommended = rows.find((r) => r.recommended);
    const tail = recommended
      ? `\nrecommend: rotate ${picked.holding.symbol} → ${recommended.dest}  payback ${recommended.paybackDays.toFixed(1)}d  +${recommended.apyUpliftPp.toFixed(2)}pp\nrun /rotate to build the tx.`
      : "\nno candidate meets payback threshold — hold.";
    await ctx.reply([header, ...top.map(fmtRotation), tail].join("\n"));
  });

  // Phase 4.3 — kill-switch. Builds an unsigned revoke_authority tx; user signs it
  // in their wallet to permanently disable the bot's rotation rights on their vault.
  bot.command("revoke", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply("no wallet bound. use /bind_wallet <pubkey>.");
      return;
    }
    const owner = new PublicKey(user.walletPubkey);
    const ix = ixRevokeAuthority(owner);
    const conn = new Connection(env.heliusRpcUrl(), "confirmed");
    const { blockhash } = await conn.getLatestBlockhash("confirmed");
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = blockhash;
    tx.feePayer = owner;
    const b64 = tx
      .serialize({ requireAllSignatures: false })
      .toString("base64");
    await ctx.reply(
      [
        "kill-switch — revokes the bot's rotation authority on your vault.",
        "sign this base64 tx in your wallet:",
        "```",
        b64,
        "```",
      ].join("\n"),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("rotate", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply("no wallet bound. use /bind_wallet <pubkey>.");
      return;
    }
    const [holdings, snapshot] = await Promise.all([
      fetchLstHoldings(user.walletPubkey),
      fetchSnapshot(TRACKED_LSTS),
    ]);
    const picked = pickSource(user, holdings, snapshot);
    if (!picked) {
      await ctx.reply("no eligible LST holdings to rotate.");
      return;
    }
    const rows = await rankRotations({
      source: picked.holding.symbol,
      sourceBalanceSol: picked.sourceBalanceSol,
      snapshot,
      paybackDaysMax: user.paybackDaysMax,
    });
    const top = rows.find((r) => r.recommended);
    if (!top) {
      await ctx.reply("no rotation meets payback threshold — hold.");
      return;
    }
    let tx;
    try {
      tx = await buildRotationTx(
        picked.holding.symbol,
        top.dest,
        picked.holding.amountBaseUnits,
        user.walletPubkey,
      );
    } catch (err) {
      await ctx.reply(`failed to build swap tx: ${(err as Error).message}`);
      return;
    }

    const host = env.botPublicHost();
    if (host) {
      const id = randomUUID();
      await registerRotation({
        id,
        telegramId: BigInt(tgId),
        walletPubkey: user.walletPubkey,
        source: picked.holding.symbol,
        dest: top.dest as LstSymbol,
        swapTransactionBase64: tx.swapTransactionBase64,
        apyUpliftPp: top.apyUpliftPp,
      });
      const actionUrl = `solana-action:${host.replace(/\/$/, "")}/api/actions/rotate/${id}`;
      await ctx.reply(
        [
          `rotate ${picked.holding.symbol} → ${top.dest}  +${top.apyUpliftPp.toFixed(2)}pp`,
          `payback ${top.paybackDays.toFixed(1)}d`,
          "",
          "open in your wallet:",
          actionUrl,
        ].join("\n"),
      );
    } else {
      await ctx.reply(
        [
          `rotate ${picked.holding.symbol} → ${top.dest}  +${top.apyUpliftPp.toFixed(2)}pp`,
          `payback ${top.paybackDays.toFixed(1)}d`,
          "",
          "BOT_PUBLIC_HOST not set — sign the base64 tx below in your wallet:",
          "```",
          tx.swapTransactionBase64,
          "```",
        ].join("\n"),
        { parse_mode: "Markdown" },
      );
    }
  });
}
