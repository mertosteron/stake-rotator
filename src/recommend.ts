import { TRACKED_LSTS, type LstSymbol } from "./lsts.ts";
import { fetchSnapshot } from "./sanctum.ts";
import { rankRotations, type Rotation } from "./calc.ts";

interface CliArgs {
  source: LstSymbol;
  balanceSol: number;
  paybackDaysMax: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let source: LstSymbol = "mSOL";
  let balanceSol = 100;
  let paybackDaysMax = 30;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = argv[i + 1];
    if ((a === "--source" || a === "-s") && next) {
      if (!TRACKED_LSTS.includes(next as LstSymbol)) {
        throw new Error(`unknown source LST: ${next}. tracked: ${TRACKED_LSTS.join(", ")}`);
      }
      source = next as LstSymbol;
      i++;
    } else if ((a === "--balance" || a === "-b") && next) {
      balanceSol = Number(next);
      if (!Number.isFinite(balanceSol) || balanceSol <= 0) {
        throw new Error(`invalid balance: ${next}`);
      }
      i++;
    } else if ((a === "--payback" || a === "-p") && next) {
      paybackDaysMax = Number(next);
      i++;
    }
  }

  return { source, balanceSol, paybackDaysMax };
}

function fmtDays(d: number): string {
  if (!Number.isFinite(d)) return "  never";
  if (d < 0) return "    n/a";
  return `${d.toFixed(1).padStart(6)}d`;
}

function printRotations(args: CliArgs, rows: Rotation[]) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log(
    `\nRotation candidates from ${args.source}  ` +
      `(balance ${args.balanceSol} SOL, payback ≤ ${args.paybackDaysMax}d)  — ${ts} UTC`,
  );
  console.log("─".repeat(78));
  console.log("flag  dest      Δapy(pp)    cost(SOL)   cost(bps)   payback     daily(SOL)");
  console.log("─".repeat(78));
  for (const r of rows) {
    const flag = r.recommended ? "  ✓" : "  •";
    const dest = r.dest.padEnd(8);
    const upl = r.apyUpliftPp.toFixed(2).padStart(7);
    const cost = r.swapCostSol.toFixed(5).padStart(10);
    const bps = r.swapCostBps.toFixed(1).padStart(7);
    const payback = fmtDays(r.paybackDays);
    const daily = r.dailyUpliftSol.toFixed(6).padStart(10);
    console.log(`${flag}   ${dest}  ${upl}    ${cost}    ${bps}    ${payback}    ${daily}`);
  }
  console.log("─".repeat(78));

  const top = rows.find((r) => r.recommended);
  if (top) {
    console.log(
      `\nrecommend: rotate ${args.balanceSol} SOL  ${args.source} → ${top.dest}  ` +
        `payback ${top.paybackDays.toFixed(1)}d  +${top.apyUpliftPp.toFixed(2)}pp APY`,
    );
  } else {
    console.log("\nno rotation meets payback threshold — hold.");
  }
  console.log();
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const snapshot = await fetchSnapshot(TRACKED_LSTS);
  const rows = await rankRotations({
    source: args.source,
    sourceBalanceSol: args.balanceSol,
    snapshot,
    paybackDaysMax: args.paybackDaysMax,
  });
  printRotations(args, rows);
}

main().catch((err) => {
  console.error("recommend failed:", err);
  process.exit(1);
});
