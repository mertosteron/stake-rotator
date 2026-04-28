import { LSTS, type LstSymbol } from "./lsts.ts";

const JUP_BASE = "https://lite-api.jup.ag/swap/v1";

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: string;
  slippageBps: number;
}

export interface JupQuote {
  inAmount: bigint;
  outAmount: bigint;
  priceImpactPct: number;
}

export async function quoteLstToLst(
  from: LstSymbol,
  to: LstSymbol,
  amountInBaseUnits: bigint,
  slippageBps = 50,
): Promise<JupQuote> {
  const params = new URLSearchParams({
    inputMint: LSTS[from].mint,
    outputMint: LSTS[to].mint,
    amount: amountInBaseUnits.toString(),
    slippageBps: slippageBps.toString(),
  });
  const res = await fetch(`${JUP_BASE}/quote?${params}`);
  if (!res.ok) throw new Error(`Jupiter ${res.status} ${res.statusText} for ${from}->${to}`);
  const data = (await res.json()) as QuoteResponse;
  return {
    inAmount: BigInt(data.inAmount),
    outAmount: BigInt(data.outAmount),
    priceImpactPct: Number(data.priceImpactPct),
  };
}
