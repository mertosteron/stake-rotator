import type { LstSymbol } from "./lsts.ts";
import { env } from "./env.ts";
import { fetchDefiLlamaApys } from "./defillama.ts";

interface ApyResponse {
  apys: Partial<Record<string, number>>;
  errs: Record<string, unknown>;
}

interface SolValueResponse {
  solValues: Partial<Record<string, string>>;
  errs: Record<string, unknown>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`Sanctum ${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as T;
}

function buildLstQuery(symbols: readonly LstSymbol[]): string {
  return symbols.map((s) => `lst=${encodeURIComponent(s)}`).join("&");
}

export async function fetchApys(
  symbols: readonly LstSymbol[],
): Promise<Map<LstSymbol, number>> {
  const url = `${env.sanctumApiBase()}/apy/latest?${buildLstQuery(symbols)}`;
  const data = await getJson<ApyResponse>(url);
  const out = new Map<LstSymbol, number>();
  for (const s of symbols) {
    const v = data.apys[s];
    // Sanctum returns 0 when it has no recent sample for an LST — treat as missing.
    if (typeof v === "number" && v > 0) out.set(s, v);
  }
  return out;
}

export async function fetchSolValues(
  symbols: readonly LstSymbol[],
): Promise<Map<LstSymbol, bigint>> {
  const url = `${env.sanctumApiBase()}/sol-value/current?${buildLstQuery(symbols)}`;
  const data = await getJson<SolValueResponse>(url);
  const out = new Map<LstSymbol, bigint>();
  for (const s of symbols) {
    const v = data.solValues[s];
    if (typeof v === "string") out.set(s, BigInt(v));
  }
  return out;
}

export interface LstSnapshot {
  symbol: LstSymbol;
  apy: number | null;
  solPerLst: number | null;
}

export async function fetchSnapshot(
  symbols: readonly LstSymbol[],
): Promise<LstSnapshot[]> {
  const [apys, solValues] = await Promise.all([
    fetchApys(symbols).catch(() => new Map<LstSymbol, number>()),
    fetchSolValues(symbols),
  ]);

  const missing = symbols.filter((s) => !apys.has(s));
  if (missing.length > 0) {
    const fallback = await fetchDefiLlamaApys(missing).catch(
      () => new Map<LstSymbol, number>(),
    );
    for (const [s, v] of fallback) apys.set(s, v);
  }

  return symbols.map((s) => {
    const raw = solValues.get(s);
    const solPerLst = raw === undefined ? null : Number(raw) / 1e9;
    return {
      symbol: s,
      apy: apys.get(s) ?? null,
      solPerLst,
    };
  });
}
