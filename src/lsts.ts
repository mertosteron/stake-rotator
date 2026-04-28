export type LstSymbol = "jitoSOL" | "mSOL" | "bSOL" | "INF" | "jupSOL" | "hSOL";

export interface LstMeta {
  symbol: LstSymbol;
  mint: string;
  decimals: number;
}

export const LSTS: Record<LstSymbol, LstMeta> = {
  jitoSOL: {
    symbol: "jitoSOL",
    mint: "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn",
    decimals: 9,
  },
  mSOL: {
    symbol: "mSOL",
    mint: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    decimals: 9,
  },
  bSOL: {
    symbol: "bSOL",
    mint: "bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1",
    decimals: 9,
  },
  INF: {
    symbol: "INF",
    mint: "5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm",
    decimals: 9,
  },
  jupSOL: {
    symbol: "jupSOL",
    mint: "jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v",
    decimals: 9,
  },
  hSOL: {
    symbol: "hSOL",
    mint: "he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A",
    decimals: 9,
  },
};

export const TRACKED_LSTS: LstSymbol[] = ["jitoSOL", "mSOL", "bSOL", "INF", "jupSOL", "hSOL"];
