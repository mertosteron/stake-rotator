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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function replyBase64Tx(
  ctx: Context,
  title: string,
  b64: string,
): Promise<void> {
  await ctx.reply(
    [title, "", "Sign this transaction in your wallet:", `<pre>${escapeHtml(b64)}</pre>`].join("\n"),
    { parse_mode: "HTML" },
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
  return `${flag} <b>${r.source} → ${r.dest}</b>  +${r.apyUpliftPp.toFixed(2)}pp  ·  payback ${payback}  ·  +${r.dailyUpliftSol.toFixed(5)} SOL/day`;
}

export function registerCommands(bot: Bot) {
  bot.command("compare", async (ctx) => {
    const tgId = ctx.from?.id;
    const ts = new Date().toISOString().replace("T", " ").slice(0, 16);

    const snapshot = await fetchSnapshot(TRACKED_LSTS);
    const ranked = [...snapshot].sort((a, b) => {
      if (a.apy === null && b.apy === null) return 0;
      if (a.apy === null) return 1;
      if (b.apy === null) return -1;
      return b.apy - a.apy;
    });

    let user: User | null = null;
    let holdings: LstHolding[] = [];
    if (tgId) {
      user = await getOrCreateUser(BigInt(tgId));
      if (user.walletPubkey) {
        try {
          holdings = await fetchLstHoldings(user.walletPubkey);
        } catch {
          holdings = [];
        }
      }
    }
    const heldSymbols = new Set(holdings.map((h) => h.symbol));

    const lines: string[] = [`📈 <b>LST Market</b>  ·  ${ts} UTC`, ""];
    for (const s of ranked) {
      const arrow = heldSymbols.has(s.symbol) ? "▸" : " ";
      const apy = s.apy === null ? "  n/a" : `${(s.apy * 100).toFixed(2)}%`;
      const rate =
        s.solPerLst === null ? "—" : `${s.solPerLst.toFixed(4)} SOL/LST`;
      const sym = s.symbol.padEnd(8);
      lines.push(`${arrow} <b>${sym}</b> ${apy.padStart(7)}  ·  ${rate}`);
    }
    const apyValues = ranked
      .map((s) => s.apy)
      .filter((a): a is number => a !== null);
    if (apyValues.length >= 2) {
      const top = ranked.find((s) => s.apy === Math.max(...apyValues));
      const bottom = ranked.find((s) => s.apy === Math.min(...apyValues));
      if (top && bottom && top.symbol !== bottom.symbol) {
        const spread = ((top.apy ?? 0) - (bottom.apy ?? 0)) * 100;
        lines.push("");
        lines.push(
          `🏆 Top APY: <b>${top.symbol}</b>  (+${spread.toFixed(2)}pp over ${bottom.symbol})`,
        );
      }
    }

    if (!user || !user.walletPubkey) {
      lines.push("");
      lines.push("Bind a wallet (/bind_wallet) for personalized advice.");
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    if (holdings.length === 0) {
      lines.push("");
      lines.push("👛 No tracked LSTs in your wallet yet.");
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    const picked = pickSource(user, holdings, snapshot);
    if (!picked) {
      lines.push("");
      lines.push("👛 No eligible LST to advise on right now.");
      await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
      return;
    }

    let rotations: Rotation[] = [];
    try {
      rotations = await rankRotations({
        source: picked.holding.symbol,
        sourceBalanceSol: picked.sourceBalanceSol,
        snapshot,
        paybackDaysMax: user.paybackDaysMax,
      });
    } catch {
      rotations = [];
    }

    lines.push("");
    lines.push(
      `🔍 <b>Your move</b> — based on ${picked.holding.amount.toFixed(4)} ${picked.holding.symbol} (≈ ${picked.sourceBalanceSol.toFixed(4)} SOL)`,
    );

    const best = rotations[0];
    if (!best || best.apyUpliftPp <= 0) {
      lines.push(
        `Hold <b>${picked.holding.symbol}</b> — nothing offers higher net yield right now.`,
      );
    } else {
      const payback = Number.isFinite(best.paybackDays)
        ? `${best.paybackDays.toFixed(1)}d`
        : "never";
      const verdict = best.recommended
        ? `✅ <b>Switch to ${best.dest}</b>`
        : `⚖️ <b>Best candidate: ${best.dest}</b>  (payback ${payback} > your ${user.paybackDaysMax}d limit)`;
      lines.push(verdict);
      lines.push(
        `Uplift: +${best.apyUpliftPp.toFixed(2)}pp APY  ·  swap cost ${best.swapCostSol.toFixed(5)} SOL  ·  payback ${payback}`,
      );
      lines.push(`Daily gain after switch: +${best.dailyUpliftSol.toFixed(5)} SOL`);
    }

    lines.push("");
    lines.push(
      "<i>Read-only — no transaction is created. Run /rotate to actually swap.</i>",
    );

    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("start", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    await getOrCreateUser(BigInt(tgId));
    await ctx.reply(
      [
        "👋 <b>Stake Rotator</b>",
        "Non-custodial LST auto-rotation on Solana.",
        "",
        "<b>Quick start</b>",
        "1. /bind_wallet <code>&lt;pubkey&gt;</code> — link your Solana wallet",
        "2. /status — view your LST holdings",
        "3. /recommend — see the best rotation",
        "",
        "<b>All commands</b>",
        "• /compare — live LST market snapshot (read-only)",
        "• /bind_wallet — link a wallet (read-only)",
        "• /status — wallet &amp; holdings",
        "• /init_vault — create your rotation vault",
        "• /deposit — fund the vault",
        "• /withdraw — pull funds out",
        "• /recommend — best rotation candidate",
        "• /rotate — build the rotation tx",
        "• /revoke — kill-switch (revoke bot authority)",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("bind_wallet", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const arg = ctx.match.trim();
    if (!arg) {
      await ctx.reply(
        "<b>Usage</b>\n/bind_wallet <code>&lt;solana-pubkey&gt;</code>",
        { parse_mode: "HTML" },
      );
      return;
    }
    if (!isValidPubkey(arg)) {
      await ctx.reply(`❌ Invalid pubkey: <code>${escapeHtml(arg)}</code>`, {
        parse_mode: "HTML",
      });
      return;
    }
    await setWallet(BigInt(tgId), arg);
    await ctx.reply(
      [
        "✅ <b>Wallet linked</b>",
        `<code>${arg}</code>`,
        "",
        "Next: /status",
      ].join("\n"),
      { parse_mode: "HTML" },
    );
  });

  bot.command("status", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply(
        "No wallet linked yet.\nUse /bind_wallet <code>&lt;pubkey&gt;</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }
    const [holdings, snapshot] = await Promise.all([
      fetchLstHoldings(user.walletPubkey),
      fetchSnapshot(TRACKED_LSTS),
    ]);
    if (holdings.length === 0) {
      await ctx.reply(
        [
          "👛 <b>Wallet</b>",
          `<code>${user.walletPubkey}</code>`,
          "",
          "📭 No tracked LSTs found in this wallet.",
          `Tracked: ${TRACKED_LSTS.join(", ")}`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }
    const bySym = new Map(snapshot.map((s) => [s.symbol, s]));
    const lines = [
      "👛 <b>Wallet</b>",
      `<code>${user.walletPubkey}</code>`,
      "",
      "📊 <b>Holdings</b>",
    ];
    let totalSol = 0;
    for (const h of holdings) {
      const snap = bySym.get(h.symbol);
      const valueSol = snap?.solPerLst ? h.amount * snap.solPerLst : null;
      const apy =
        snap?.apy != null ? `${(snap.apy * 100).toFixed(2)}% APY` : "APY n/a";
      const valueStr = valueSol === null ? "—" : `${valueSol.toFixed(4)} SOL`;
      lines.push(
        `• <b>${h.symbol}</b> — ${h.amount.toFixed(4)}  (≈ ${valueStr} · ${apy})`,
      );
      if (valueSol !== null) totalSol += valueSol;
    }
    lines.push("");
    lines.push(`💰 <b>Total</b> — ${totalSol.toFixed(4)} SOL`);
    lines.push("");
    lines.push(
      `⚙️ Payback ≤ ${user.paybackDaysMax}d  ·  Source: ${user.sourceLst ?? "auto"}`,
    );
    await ctx.reply(lines.join("\n"), { parse_mode: "HTML" });
  });

  bot.command("init_vault", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply(
        "No wallet linked yet.\nUse /bind_wallet <code>&lt;pubkey&gt;</code>.",
        { parse_mode: "HTML" },
      );
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
        [
          "<b>Usage</b>",
          "/init_vault <code>[perf_fee_bps_max]</code>",
          "Range: 0–2000 bps  ·  Default: 250",
        ].join("\n"),
        { parse_mode: "HTML" },
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
      [
        "🏦 <b>Init vault</b>",
        `Rotation authority: <code>${rotationAuthority.toBase58()}</code>`,
        `Max perf fee: ${perfFeeBpsMax} bps`,
      ].join("\n"),
      b64,
    );
  });

  bot.command("deposit", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply(
        "No wallet linked yet.\nUse /bind_wallet <code>&lt;pubkey&gt;</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }

    const [symbolRaw, amountRaw] = ctx.match.trim().split(/\s+/);
    const symbol = symbolRaw ? parseLstSymbol(symbolRaw) : null;
    if (!symbol || !amountRaw) {
      await ctx.reply(
        [
          "<b>Usage</b>",
          `/deposit <code>&lt;${TRACKED_LSTS.join("|")}&gt; &lt;amount&gt;</code>`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }
    const meta = LSTS[symbol];
    const amount = parseUiAmount(amountRaw, meta.decimals);
    if (!amount || amount <= 0n) {
      await ctx.reply(
        `❌ Invalid amount for <b>${symbol}</b>: <code>${escapeHtml(amountRaw)}</code>`,
        { parse_mode: "HTML" },
      );
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
      [
        `⬇️ <b>Deposit</b> ${amountRaw} ${symbol} → vault`,
        `Vault: <code>${vault.toBase58()}</code>`,
      ].join("\n"),
      b64,
    );
  });

  bot.command("withdraw", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply(
        "No wallet linked yet.\nUse /bind_wallet <code>&lt;pubkey&gt;</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }

    const [symbolRaw, amountRaw] = ctx.match.trim().split(/\s+/);
    const symbol = symbolRaw ? parseLstSymbol(symbolRaw) : null;
    if (!symbol || !amountRaw) {
      await ctx.reply(
        [
          "<b>Usage</b>",
          `/withdraw <code>&lt;${TRACKED_LSTS.join("|")}&gt; &lt;amount&gt;</code>`,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
      return;
    }
    const meta = LSTS[symbol];
    const amount = parseUiAmount(amountRaw, meta.decimals);
    if (!amount || amount <= 0n) {
      await ctx.reply(
        `❌ Invalid amount for <b>${symbol}</b>: <code>${escapeHtml(amountRaw)}</code>`,
        { parse_mode: "HTML" },
      );
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
      [
        `⬆️ <b>Withdraw</b> ${amountRaw} ${symbol} ← vault`,
        `Vault: <code>${vault.toBase58()}</code>`,
      ].join("\n"),
      b64,
    );
  });

  bot.command("recommend", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply(
        "No wallet linked yet.\nUse /bind_wallet <code>&lt;pubkey&gt;</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }
    const [holdings, snapshot] = await Promise.all([
      fetchLstHoldings(user.walletPubkey),
      fetchSnapshot(TRACKED_LSTS),
    ]);
    const picked = pickSource(user, holdings, snapshot);
    if (!picked) {
      await ctx.reply(
        "No eligible LSTs to rotate.\nUse /deposit to fund your vault first.",
      );
      return;
    }
    const rows = await rankRotations({
      source: picked.holding.symbol,
      sourceBalanceSol: picked.sourceBalanceSol,
      snapshot,
      paybackDaysMax: user.paybackDaysMax,
    });
    if (rows.length === 0) {
      await ctx.reply("No rotation candidates available right now.");
      return;
    }
    const top = rows.slice(0, 3);
    const header = [
      `🔄 <b>Source</b> ${picked.holding.symbol} — ${picked.sourceBalanceSol.toFixed(4)} SOL`,
      `Payback ≤ ${user.paybackDaysMax}d`,
      "",
      "<b>Candidates</b>",
    ].join("\n");
    const recommended = rows.find((r) => r.recommended);
    const tail = recommended
      ? [
          "",
          `✅ <b>Recommended</b> — rotate ${picked.holding.symbol} → ${recommended.dest}`,
          `Payback: ${recommended.paybackDays.toFixed(1)}d  ·  Uplift: +${recommended.apyUpliftPp.toFixed(2)}pp`,
          "",
          "Run /rotate to build the tx.",
        ].join("\n")
      : "\nNo candidate meets your payback threshold — hold for now.";
    await ctx.reply([header, ...top.map(fmtRotation), tail].join("\n"), {
      parse_mode: "HTML",
    });
  });

  // Phase 4.3 — kill-switch. Builds an unsigned revoke_authority tx; user signs it
  // in their wallet to permanently disable the bot's rotation rights on their vault.
  bot.command("revoke", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply(
        "No wallet linked yet.\nUse /bind_wallet <code>&lt;pubkey&gt;</code>.",
        { parse_mode: "HTML" },
      );
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
    await replyBase64Tx(
      ctx,
      [
        "🛑 <b>Kill-switch</b>",
        "This revokes the bot's rotation authority on your vault.",
      ].join("\n"),
      b64,
    );
  });

  bot.command("rotate", async (ctx) => {
    const tgId = ctx.from?.id;
    if (!tgId) return;
    const user = await getOrCreateUser(BigInt(tgId));
    if (!user.walletPubkey) {
      await ctx.reply(
        "No wallet linked yet.\nUse /bind_wallet <code>&lt;pubkey&gt;</code>.",
        { parse_mode: "HTML" },
      );
      return;
    }
    const [holdings, snapshot] = await Promise.all([
      fetchLstHoldings(user.walletPubkey),
      fetchSnapshot(TRACKED_LSTS),
    ]);
    const picked = pickSource(user, holdings, snapshot);
    if (!picked) {
      await ctx.reply(
        "No eligible LSTs to rotate.\nUse /deposit to fund your vault first.",
      );
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
      await ctx.reply(
        "No rotation meets your payback threshold — hold for now.",
      );
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
      await ctx.reply(
        `❌ Failed to build swap tx: ${escapeHtml((err as Error).message)}`,
        { parse_mode: "HTML" },
      );
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
          `🔄 <b>Rotate</b> ${picked.holding.symbol} → ${top.dest}  +${top.apyUpliftPp.toFixed(2)}pp`,
          `Payback: ${top.paybackDays.toFixed(1)}d`,
          "",
          "Open in your wallet:",
          actionUrl,
        ].join("\n"),
        { parse_mode: "HTML" },
      );
    } else {
      await replyBase64Tx(
        ctx,
        [
          `🔄 <b>Rotate</b> ${picked.holding.symbol} → ${top.dest}  +${top.apyUpliftPp.toFixed(2)}pp`,
          `Payback: ${top.paybackDays.toFixed(1)}d`,
        ].join("\n"),
        tx.swapTransactionBase64,
      );
    }
  });
}
