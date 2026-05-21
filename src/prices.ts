import { LSTS, type LstSymbol } from "./lsts.ts";

// Wrapped SOL mint — used as the SOL/USD reference price.
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Jupiter's lite tier price endpoint (v3). Free, no key. Returns a flat object
// keyed by mint, each value carrying usdPrice as a number.
const JUPITER_PRICE_BASE = "https://lite-api.jup.ag/price/v3";

interface JupiterPriceEntry {
  usdPrice: number;
  blockId?: number;
  decimals?: number;
  priceChange24h?: number;
}

async function fetchJupiterPrices(
  mints: readonly string[],
): Promise<Map<string, number>> {
  const ids = mints.join(",");
  const url = `${JUPITER_PRICE_BASE}?ids=${encodeURIComponent(ids)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Jupiter price ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as Record<string, JupiterPriceEntry | null>;
  const out = new Map<string, number>();
  for (const [mint, entry] of Object.entries(json)) {
    if (!entry) continue;
    const v = entry.usdPrice;
    if (Number.isFinite(v) && v > 0) out.set(mint, v);
  }
  return out;
}

export interface PriceSnapshot {
  // USD per 1 SOL.
  usdPerSol: number;
  // USD per 1 LST unit (UI amount), per symbol. Filled either directly from
  // Jupiter or derived as solPerLst * usdPerSol when Jupiter returns null.
  usdPerLst: Map<LstSymbol, number>;
}

export async function fetchPriceSnapshot(
  symbols: readonly LstSymbol[],
  solPerLstFallback: Map<LstSymbol, number | null>,
): Promise<PriceSnapshot> {
  const mints = [WSOL_MINT, ...symbols.map((s) => LSTS[s].mint)];
  const prices = await fetchJupiterPrices(mints).catch(
    () => new Map<string, number>(),
  );

  const usdPerSol = prices.get(WSOL_MINT);
  if (!usdPerSol) {
    throw new Error("could not fetch SOL/USD price from Jupiter");
  }

  const usdPerLst = new Map<LstSymbol, number>();
  for (const sym of symbols) {
    const direct = prices.get(LSTS[sym].mint);
    if (direct) {
      usdPerLst.set(sym, direct);
      continue;
    }
    const solPerLst = solPerLstFallback.get(sym);
    if (solPerLst != null) usdPerLst.set(sym, solPerLst * usdPerSol);
  }

  return { usdPerSol, usdPerLst };
}
