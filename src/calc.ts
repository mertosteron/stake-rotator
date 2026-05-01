import { LSTS, type LstSymbol } from "./lsts.ts";
import type { LstSnapshot } from "./sanctum.ts";
import { quoteLstToLst } from "./jupiter.ts";

export interface Rotation {
  source: LstSymbol;
  dest: LstSymbol;
  sourceApy: number;
  destApy: number;
  apyUpliftPp: number;
  inputSol: number;
  outputSol: number;
  swapCostSol: number;
  swapCostBps: number;
  dailyUpliftSol: number;
  paybackDays: number;
  recommended: boolean;
}

export interface RankRotationsArgs {
  source: LstSymbol;
  sourceBalanceSol: number;
  snapshot: LstSnapshot[];
  paybackDaysMax?: number;
  slippageBps?: number;
}

function toBaseUnits(amountLst: number, decimals: number): bigint {
  return BigInt(Math.floor(amountLst * 10 ** decimals));
}

export async function rankRotations(
  args: RankRotationsArgs,
): Promise<Rotation[]> {
  const { source, sourceBalanceSol, snapshot } = args;
  const paybackDaysMax = args.paybackDaysMax ?? 30;
  const slippageBps = args.slippageBps ?? 50;

  const bySymbol = new Map(snapshot.map((s) => [s.symbol, s]));
  const src = bySymbol.get(source);
  if (!src) throw new Error(`source ${source} not in snapshot`);
  if (src.apy === null || src.solPerLst === null) {
    throw new Error(`source ${source} missing apy or sol-value`);
  }

  const sourceLstAmount = sourceBalanceSol / src.solPerLst;
  const sourceBaseUnits = toBaseUnits(sourceLstAmount, LSTS[source].decimals);

  const candidates = snapshot.filter(
    (s) => s.symbol !== source && s.apy !== null && s.solPerLst !== null,
  );

  const quotes = await Promise.all(
    candidates.map(async (dest) => {
      try {
        const q = await quoteLstToLst(
          source,
          dest.symbol,
          sourceBaseUnits,
          slippageBps,
        );
        return { dest, quote: q };
      } catch (err) {
        return { dest, error: err };
      }
    }),
  );

  const rotations: Rotation[] = [];
  for (const item of quotes) {
    if ("error" in item) continue;
    const { dest, quote } = item;
    if (dest.apy === null || dest.solPerLst === null) continue;

    const outputLstAmount =
      Number(quote.outAmount) / 10 ** LSTS[dest.symbol].decimals;
    const outputSol = outputLstAmount * dest.solPerLst;
    const swapCostSol = sourceBalanceSol - outputSol;
    const swapCostBps = (swapCostSol / sourceBalanceSol) * 10_000;

    const apyUplift = dest.apy - src.apy;
    const dailyUpliftSol = (outputSol * apyUplift) / 365;
    let paybackDays: number;
    if (apyUplift <= 0) paybackDays = Infinity;
    else if (swapCostSol <= 0) paybackDays = 0;
    else paybackDays = swapCostSol / dailyUpliftSol;

    rotations.push({
      source,
      dest: dest.symbol,
      sourceApy: src.apy,
      destApy: dest.apy,
      apyUpliftPp: apyUplift * 100,
      inputSol: sourceBalanceSol,
      outputSol,
      swapCostSol,
      swapCostBps,
      dailyUpliftSol,
      paybackDays,
      recommended: apyUplift > 0 && paybackDays <= paybackDaysMax,
    });
  }

  return rotations.sort((a, b) => {
    if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
    if (a.recommended) return b.dailyUpliftSol - a.dailyUpliftSol;
    return a.paybackDays - b.paybackDays;
  });
}

export const _internal = { toBaseUnits };
