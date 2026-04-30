import { LSTS, type LstSymbol } from "./lsts.ts";

const JUP_BASE = "https://lite-api.jup.ag/swap/v1";

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown;
  contextSlot?: number;
  timeTaken?: number;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

export interface RotationTx {
  swapTransactionBase64: string;
  lastValidBlockHeight: number;
  inputMint: string;
  outputMint: string;
  inAmount: bigint;
  outAmount: bigint;
}

export async function buildRotationTx(
  from: LstSymbol,
  to: LstSymbol,
  amountInBaseUnits: bigint,
  userPublicKey: string,
  slippageBps = 50,
): Promise<RotationTx> {
  const params = new URLSearchParams({
    inputMint: LSTS[from].mint,
    outputMint: LSTS[to].mint,
    amount: amountInBaseUnits.toString(),
    slippageBps: slippageBps.toString(),
  });
  const quoteRes = await fetch(`${JUP_BASE}/quote?${params}`);
  if (!quoteRes.ok) {
    throw new Error(`Jupiter quote ${quoteRes.status} ${quoteRes.statusText}`);
  }
  const quote = (await quoteRes.json()) as QuoteResponse;

  const swapRes = await fetch(`${JUP_BASE}/swap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      userPublicKey,
      wrapAndUnwrapSol: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  if (!swapRes.ok) {
    const text = await swapRes.text().catch(() => "");
    throw new Error(`Jupiter swap ${swapRes.status} ${swapRes.statusText} ${text}`);
  }
  const swap = (await swapRes.json()) as SwapResponse;

  return {
    swapTransactionBase64: swap.swapTransaction,
    lastValidBlockHeight: swap.lastValidBlockHeight,
    inputMint: quote.inputMint,
    outputMint: quote.outputMint,
    inAmount: BigInt(quote.inAmount),
    outAmount: BigInt(quote.outAmount),
  };
}
