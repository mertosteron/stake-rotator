import type { LstSymbol } from "./lsts.ts";

const POOL_IDS: Record<LstSymbol, string> = {
  jitoSOL: "0e7d0722-9054-4907-8593-567b353c0900",
  mSOL: "b3f93865-5ec8-4662-90a0-11808e0aa2bd",
  bSOL: "387d6732-59f0-4ae0-8a88-aba75a5cbe4a",
  INF: "3075a746-bdd1-4aac-bcd5-b035abee2622",
  jupSOL: "52bd72a7-9e81-4112-abb4-71673e8de9bf",
  hSOL: "d7e101d6-8e6c-4348-9c5f-62398872a301",
};

interface ChartPoint {
  timestamp: string;
  apy: number | null;
  apyBase: number | null;
}

interface ChartResponse {
  status: string;
  data: ChartPoint[];
}

async function fetchPoolApy(poolId: string): Promise<number | null> {
  const res = await fetch(`https://yields.llama.fi/chart/${poolId}`);
  if (!res.ok) return null;
  const json = (await res.json()) as ChartResponse;
  const points = json.data;
  if (!points || points.length === 0) return null;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (!p) continue;
    const v = p.apy ?? p.apyBase;
    if (typeof v === "number" && v > 0) return v / 100;
  }
  return null;
}

export async function fetchDefiLlamaApys(
  symbols: readonly LstSymbol[],
): Promise<Map<LstSymbol, number>> {
  const out = new Map<LstSymbol, number>();
  const results = await Promise.all(
    symbols.map(async (s) => {
      const id = POOL_IDS[s];
      if (!id) return [s, null] as const;
      try {
        return [s, await fetchPoolApy(id)] as const;
      } catch {
        return [s, null] as const;
      }
    }),
  );
  for (const [s, v] of results) {
    if (v !== null) out.set(s, v);
  }
  return out;
}
