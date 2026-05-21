import { and, asc, desc, eq, gte } from "drizzle-orm";
import { getDb } from "./db/client.ts";
import {
  apySnapshots,
  positionSnapshots,
  rotationEvents,
  type PositionSnapshotRow,
  type RotationEventRow,
} from "./db/schema.ts";
import { TRACKED_LSTS, type LstSymbol } from "./lsts.ts";
import { fetchLstHoldings, type LstHolding } from "./balances.ts";
import { fetchSnapshot, type LstSnapshot } from "./sanctum.ts";
import { fetchPriceSnapshot, type PriceSnapshot } from "./prices.ts";

const MIN_HISTORY_DAYS = 1;

export interface EarningsReport {
  // True once we have an initial position snapshot AND at least one day of
  // elapsed time. Before that, /earnings prints a "tracking started" stub.
  hasHistory: boolean;
  walletPubkey: string;
  currentLst: LstSymbol | null;
  // Realized side.
  daysHeld: number;
  initialUsd: number;
  currentUsd: number;
  pnlUsd: number;
  pnlPct: number;
  effectiveApy: number | null;
  // Alternative scenarios. Includes the current LST too (📍).
  alternatives: AlternativeRow[];
  rotationHistory: RotationSummary;
}

export interface AlternativeRow {
  symbol: LstSymbol;
  currentApy: number | null;
  // Time-weighted average APY across the holding period. Falls back to
  // currentApy when we have <2 APY samples for the symbol.
  averageApy: number | null;
  hypotheticalUsd: number;
  deltaUsd: number;
  isCurrent: boolean;
  isBest: boolean;
}

export interface RotationSummary {
  count: number;
  estimatedContributionUsd: number;
}

// Snapshot the user's wallet positions for /earnings cost-basis tracking. Called
// lazily on the first /earnings invocation and after every rotate.
export async function captureCurrentPositions(args: {
  telegramId: bigint;
  walletPubkey: string;
}): Promise<PositionSnapshotRow[]> {
  const holdings = await fetchLstHoldings(args.walletPubkey);
  if (holdings.length === 0) return [];

  const snapshot = await fetchSnapshot(TRACKED_LSTS);
  const solPerLstMap = new Map<LstSymbol, number | null>();
  for (const s of snapshot) solPerLstMap.set(s.symbol, s.solPerLst);

  const prices = await fetchPriceSnapshot(TRACKED_LSTS, solPerLstMap);

  const rows = [] as PositionSnapshotRow[];
  const db = getDb();
  for (const h of holdings) {
    const usdPerLst = prices.usdPerLst.get(h.symbol);
    const solPerLst = solPerLstMap.get(h.symbol);
    if (usdPerLst == null || solPerLst == null) continue;
    const inserted = await db
      .insert(positionSnapshots)
      .values({
        telegramId: args.telegramId,
        lstSymbol: h.symbol,
        amountLst: h.amount,
        amountBaseUnits: h.amountBaseUnits.toString(),
        solPerLst,
        usdPerSol: prices.usdPerSol,
        usdValue: h.amount * usdPerLst,
      })
      .returning();
    if (inserted[0]) rows.push(inserted[0]);
  }
  return rows;
}

export async function logRotationEvent(args: {
  telegramId: bigint;
  fromLst: LstSymbol;
  toLst: LstSymbol;
  amountLstIn: number;
  usdValueAtEvent: number;
  apyUpliftPp: number;
}): Promise<void> {
  const db = getDb();
  await db.insert(rotationEvents).values({
    telegramId: args.telegramId,
    fromLst: args.fromLst,
    toLst: args.toLst,
    amountLstIn: args.amountLstIn,
    usdValueAtEvent: args.usdValueAtEvent,
    apyUpliftPp: args.apyUpliftPp,
  });
}

// Record an APY observation for every tracked LST. Called by the worker on each
// poll tick. Skips symbols with no APY data this round.
export async function captureApySnapshot(snapshot: LstSnapshot[]): Promise<void> {
  const db = getDb();
  const rows = snapshot
    .filter((s): s is LstSnapshot & { apy: number } => s.apy != null)
    .map((s) => ({ lstSymbol: s.symbol, apy: s.apy }));
  if (rows.length === 0) return;
  await db.insert(apySnapshots).values(rows);
}

async function loadFirstSnapshot(
  telegramId: bigint,
): Promise<PositionSnapshotRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(positionSnapshots)
    .where(eq(positionSnapshots.telegramId, telegramId))
    .orderBy(asc(positionSnapshots.capturedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function loadRotationEvents(
  telegramId: bigint,
): Promise<RotationEventRow[]> {
  const db = getDb();
  return db
    .select()
    .from(rotationEvents)
    .where(eq(rotationEvents.telegramId, telegramId))
    .orderBy(desc(rotationEvents.occurredAt));
}

// Time-weighted average APY for a symbol over the holding window. Trapezoidal
// integration: for each consecutive APY sample pair, weight (apy_i + apy_{i+1})/2
// by the elapsed seconds, then divide total by window seconds.
async function averageApy(
  symbol: LstSymbol,
  since: Date,
): Promise<number | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(apySnapshots)
    .where(
      and(
        eq(apySnapshots.lstSymbol, symbol),
        gte(apySnapshots.capturedAt, since),
      ),
    )
    .orderBy(asc(apySnapshots.capturedAt));
  if (rows.length < 2) return null;
  let weighted = 0;
  let totalSeconds = 0;
  for (let i = 0; i < rows.length - 1; i++) {
    const a = rows[i]!;
    const b = rows[i + 1]!;
    const dt =
      (b.capturedAt.getTime() - a.capturedAt.getTime()) / 1000;
    if (dt <= 0) continue;
    weighted += ((a.apy + b.apy) / 2) * dt;
    totalSeconds += dt;
  }
  return totalSeconds > 0 ? weighted / totalSeconds : null;
}

export async function computeEarningsReport(args: {
  telegramId: bigint;
  walletPubkey: string;
}): Promise<EarningsReport> {
  const first = await loadFirstSnapshot(args.telegramId);
  const now = new Date();

  const [holdings, marketSnapshot, rotations] = await Promise.all([
    fetchLstHoldings(args.walletPubkey),
    fetchSnapshot(TRACKED_LSTS),
    loadRotationEvents(args.telegramId),
  ]);
  const solPerLstMap = new Map<LstSymbol, number | null>();
  for (const s of marketSnapshot) solPerLstMap.set(s.symbol, s.solPerLst);
  const apyBySymbol = new Map<LstSymbol, number | null>();
  for (const s of marketSnapshot) apyBySymbol.set(s.symbol, s.apy);

  const prices: PriceSnapshot = await fetchPriceSnapshot(
    TRACKED_LSTS,
    solPerLstMap,
  );

  // Current portfolio USD value across all tracked LSTs in the wallet.
  let currentUsd = 0;
  let topHolding: LstHolding | null = null;
  for (const h of holdings) {
    const usdPerLst = prices.usdPerLst.get(h.symbol);
    if (usdPerLst == null) continue;
    const v = h.amount * usdPerLst;
    currentUsd += v;
    if (!topHolding || h.amount * (prices.usdPerLst.get(h.symbol) ?? 0) >
        topHolding.amount * (prices.usdPerLst.get(topHolding.symbol) ?? 0)) {
      topHolding = h;
    }
  }
  const currentLst: LstSymbol | null = topHolding?.symbol ?? null;

  if (!first) {
    return {
      hasHistory: false,
      walletPubkey: args.walletPubkey,
      currentLst,
      daysHeld: 0,
      initialUsd: 0,
      currentUsd,
      pnlUsd: 0,
      pnlPct: 0,
      effectiveApy: null,
      alternatives: [],
      rotationHistory: { count: 0, estimatedContributionUsd: 0 },
    };
  }

  const elapsedMs = now.getTime() - first.capturedAt.getTime();
  const daysHeld = elapsedMs / (24 * 3600 * 1000);
  const initialUsd = first.usdValue;
  const pnlUsd = currentUsd - initialUsd;
  const pnlPct = initialUsd > 0 ? (pnlUsd / initialUsd) * 100 : 0;
  const effectiveApy =
    initialUsd > 0 && daysHeld > MIN_HISTORY_DAYS
      ? Math.pow(currentUsd / initialUsd, 365 / daysHeld) - 1
      : null;

  // Alternative scenarios: had the user held this whole period in another LST,
  // what would today's USD value be? Uses time-weighted average APY when
  // available, falling back to current APY when we don't have enough samples.
  const alternatives: AlternativeRow[] = [];
  let bestSymbol: LstSymbol | null = null;
  let bestDelta = -Infinity;

  for (const sym of TRACKED_LSTS) {
    const cur = apyBySymbol.get(sym) ?? null;
    const avg = await averageApy(sym, first.capturedAt);
    const effectiveAvg = avg ?? cur;
    const hypotheticalUsd =
      effectiveAvg != null
        ? initialUsd * Math.pow(1 + effectiveAvg, daysHeld / 365)
        : initialUsd;
    const deltaUsd = hypotheticalUsd - currentUsd;
    alternatives.push({
      symbol: sym,
      currentApy: cur,
      averageApy: effectiveAvg,
      hypotheticalUsd,
      deltaUsd,
      isCurrent: sym === currentLst,
      isBest: false,
    });
    if (hypotheticalUsd > bestDelta) {
      bestDelta = hypotheticalUsd;
      bestSymbol = sym;
    }
  }
  if (bestSymbol) {
    const row = alternatives.find((a) => a.symbol === bestSymbol);
    if (row) row.isBest = true;
  }

  alternatives.sort((a, b) => b.hypotheticalUsd - a.hypotheticalUsd);

  const rotationContributionUsd = rotations.reduce((acc, r) => {
    // Rough contribution estimate: APY uplift × USD-at-event × time-since-event.
    const seconds = (now.getTime() - r.occurredAt.getTime()) / 1000;
    const fractionOfYear = seconds / (365 * 24 * 3600);
    const upliftFraction = r.apyUpliftPp / 100;
    return acc + r.usdValueAtEvent * upliftFraction * fractionOfYear;
  }, 0);

  return {
    hasHistory: daysHeld >= MIN_HISTORY_DAYS,
    walletPubkey: args.walletPubkey,
    currentLst,
    daysHeld,
    initialUsd,
    currentUsd,
    pnlUsd,
    pnlPct,
    effectiveApy,
    alternatives,
    rotationHistory: {
      count: rotations.length,
      estimatedContributionUsd: rotationContributionUsd,
    },
  };
}

export function formatEarningsReport(r: EarningsReport): string {
  const lines: string[] = ["📊 <b>Earnings Report</b>", "──────────────────"];
  if (!r.hasHistory) {
    lines.push(
      `📍 Current LST: <b>${r.currentLst ?? "n/a"}</b>`,
      `💰 Current value: $${r.currentUsd.toFixed(2)}`,
      "",
      "<i>Tracking started — your initial position has been recorded.</i>",
      "<i>Run /earnings again after 24h+ for a comparison report.</i>",
    );
    return lines.join("\n");
  }
  lines.push(
    `📍 Current LST: <b>${r.currentLst ?? "n/a"}</b>`,
    `⏱ Duration: ${r.daysHeld.toFixed(1)} days`,
    `💰 Initial: $${r.initialUsd.toFixed(2)}`,
    `💰 Current: $${r.currentUsd.toFixed(2)}`,
    `${r.pnlUsd >= 0 ? "✅" : "🔻"} PnL: ${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)} (${r.pnlPct >= 0 ? "+" : ""}${r.pnlPct.toFixed(2)}%)`,
  );
  if (r.effectiveApy != null) {
    lines.push(`📈 Effective APY: ~${(r.effectiveApy * 100).toFixed(2)}%`);
  }

  lines.push("", "<b>Alternative scenarios</b> (same period)", "──────────────────");
  for (const a of r.alternatives) {
    const marker = a.isCurrent ? "📍" : a.isBest ? "🏆" : "  ";
    const apyStr = a.averageApy != null
      ? `${(a.averageApy * 100).toFixed(2)}%`
      : "n/a";
    const delta = a.hypotheticalUsd - r.currentUsd;
    let deltaStr: string;
    if (a.isCurrent) {
      deltaStr = "(your actual position)";
    } else if (delta >= 0) {
      deltaStr = `(+$${delta.toFixed(2)} more)`;
    } else {
      deltaStr = `(-$${Math.abs(delta).toFixed(2)} less)`;
    }
    lines.push(
      `${marker} <b>${a.symbol.padEnd(8)}</b> ${apyStr.padStart(7)}  →  $${a.hypotheticalUsd.toFixed(2)} ${deltaStr}`,
    );
  }

  if (r.rotationHistory.count > 0) {
    lines.push(
      "",
      "<b>Rotation history</b>",
      `🔄 ${r.rotationHistory.count} rotation(s)  ·  est. contribution +$${r.rotationHistory.estimatedContributionUsd.toFixed(2)}`,
    );
  }

  lines.push(
    "",
    "<i>APY uses time-weighted average from on-chain history when available, otherwise current rate.</i>",
  );
  return lines.join("\n");
}
