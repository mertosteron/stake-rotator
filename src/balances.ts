import { LSTS, type LstSymbol } from "./lsts.ts";
import { env } from "./env.ts";
import { TOKEN_PROGRAM_ID } from "./const.ts";

interface RpcResponse<T> {
  jsonrpc: "2.0";
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

interface ParsedTokenAccount {
  account: {
    data: {
      parsed: {
        info: {
          mint: string;
          tokenAmount: { amount: string; decimals: number; uiAmount: number };
        };
      };
    };
  };
}

export interface LstHolding {
  symbol: LstSymbol;
  amount: number;
  amountBaseUnits: bigint;
}

// All currently tracked LSTs use the legacy SPL Token program.
// If a Token-2022 LST is added to TRACKED_LSTS, also query TOKEN_2022_PROGRAM_ID.

export async function fetchLstHoldings(
  walletPubkey: string,
): Promise<LstHolding[]> {
  const url = env.heliusRpcUrl();
  const body = {
    jsonrpc: "2.0" as const,
    id: 1,
    method: "getTokenAccountsByOwner",
    params: [
      walletPubkey,
      { programId: TOKEN_PROGRAM_ID.toBase58() },
      { encoding: "jsonParsed", commitment: "confirmed" },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Helius RPC ${res.status} ${res.statusText}`);
  const json = (await res.json()) as RpcResponse<{
    value: ParsedTokenAccount[];
  }>;
  if (json.error) throw new Error(`Helius RPC error: ${json.error.message}`);
  if (!json.result) throw new Error("Helius RPC: empty result");

  const mintToSymbol = new Map<string, LstSymbol>();
  for (const sym of Object.keys(LSTS) as LstSymbol[]) {
    mintToSymbol.set(LSTS[sym].mint, sym);
  }

  const holdings: LstHolding[] = [];
  for (const acct of json.result.value) {
    const info = acct.account.data.parsed.info;
    const sym = mintToSymbol.get(info.mint);
    if (!sym) continue;
    const baseUnits = BigInt(info.tokenAmount.amount);
    if (baseUnits === 0n) continue;
    holdings.push({
      symbol: sym,
      amount: info.tokenAmount.uiAmount,
      amountBaseUnits: baseUnits,
    });
  }
  return holdings;
}
