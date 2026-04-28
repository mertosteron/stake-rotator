import { TRACKED_LSTS } from "./lsts.ts";
import { fetchSnapshot, type LstSnapshot } from "./sanctum.ts";

function pct(x: number | null): string {
  return x === null ? "    n/a" : `${(x * 100).toFixed(2).padStart(6)}%`;
}

function rate(x: number | null): string {
  return x === null ? "  n/a" : x.toFixed(6);
}

function rank(snap: LstSnapshot[]): LstSnapshot[] {
  return [...snap].sort((a, b) => (b.apy ?? -Infinity) - (a.apy ?? -Infinity));
}

async function main() {
  const snap = await fetchSnapshot(TRACKED_LSTS);
  const ranked = rank(snap);

  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(`\nSanctum LST snapshot — ${ts} UTC`);
  console.log("─".repeat(48));
  console.log("rank  lst       apy         sol/lst");
  console.log("─".repeat(48));
  ranked.forEach((s, i) => {
    const r = `${i + 1}`.padStart(2);
    const sym = s.symbol.padEnd(8);
    console.log(`  ${r}.  ${sym}  ${pct(s.apy)}    ${rate(s.solPerLst)}`);
  });
  console.log("─".repeat(48));

  const withApy = ranked.filter((s): s is LstSnapshot & { apy: number } => s.apy !== null);
  const top = withApy[0];
  const bottom = withApy[withApy.length - 1];
  if (top && bottom && top !== bottom) {
    const spread = (top.apy - bottom.apy) * 100;
    console.log(`spread (top − bottom): ${spread.toFixed(2)} pp  (${bottom.symbol} → ${top.symbol})`);
  }
  console.log();
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
