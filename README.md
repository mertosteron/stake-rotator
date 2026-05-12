# Stake Rotator

Non-custodial LST auto-rotation bot for Solana, operated over Telegram.

Connect your wallet, deposit LSTs into a vault you own, and the bot finds the highest-APY rotation net of swap cost. You can revoke its authority at any time with a single transaction.

---

## How it works

1. `/bind_wallet` — link your Solana wallet to the bot
2. `/init_vault` — create your on-chain vault (a PDA seeded by your pubkey)
3. `/deposit` — move LSTs into the vault
4. `/recommend` — see the best rotation candidate and its payback estimate
5. `/rotate` — sign the swap in your wallet (Phantom, etc.)
6. `/revoke` — kill switch: removes bot authority from your vault instantly

The bot never holds your funds. The vault PDA is owned by you; the bot only has permission to call `execute_rotation`, and only through a pinned Jupiter v6 program ID.

---

## Rotation math

```
swap_cost_sol  = input_sol − output_sol       (from Jupiter quote)
apy_uplift     = dest_apy − source_apy
payback_days   = swap_cost_sol / (output_sol × apy_uplift / 365)
recommended    = apy_uplift > 0 AND payback_days ≤ 30
```

Results are sorted: recommended rotations first (by daily uplift), then the rest.

---

## Tracked LSTs

| Symbol  | Mint |
| ------- | ---- |
| jitoSOL | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn` |
| mSOL    | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So` |
| bSOL    | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1` |
| INF     | `5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm` |
| jupSOL  | `jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v` |
| hSOL    | `he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A` |

To add a new LST: extend `LSTS` and `TRACKED_LSTS` in `src/lsts.ts`, then verify Sanctum returns APY and SOL/LST rate for it (`pnpm probe`).

---

## Quick start

```bash
pnpm install
cp .env.example .env   # fill in at minimum HELIUS_RPC_URL
pnpm probe             # verify Sanctum data for tracked LSTs
pnpm recommend --source mSOL --balance 100 --payback 30

# To run the bot:
pnpm migrate           # provision Postgres and run migrations
pnpm bot               # start Telegram bot (+ Actions server)
pnpm worker            # start rotation executor (separate process)
```

---

## Environment variables

See `.env.example` for descriptions. Minimum required per component:

| Component      | Required variables |
| -------------- | ------------------ |
| `pnpm probe`   | `HELIUS_RPC_URL` |
| `pnpm bot`     | + `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, `ROTATION_AUTHORITY_PUBKEY` |
| `pnpm worker`  | + `BOT_KEYPAIR_PATH` |

---

## Stack

- **Telegram:** [grammy](https://grammy.dev)
- **Solana program:** Anchor (Rust), `onchain/programs/stake_rotator/`
- **DB:** Postgres + Drizzle ORM
- **Data:** Sanctum extra-api (APY + SOL value), Jupiter swap API, Helius RPC
- **Runtime:** Node 22, pnpm 10, TypeScript (tsx)

---

## Architecture

```
Telegram user
     │
     ▼
 grammy bot  ──────────────────────────────┐
 src/bot/                                  │
     │ pending rotations                   │
     ▼                                     ▼
 Actions server                        Postgres
 src/actions/server.ts                 (drizzle)
     │                                     │
     ▼                                     ▼
 Solana wallet (user signs)         Rotation worker
                                    src/worker/index.ts
                                          │
                              ┌───────────┴──────────┐
                              ▼                      ▼
                        Sanctum API            Jupiter API
                        (APY + rates)          (swap routes)
                                    │
                                    ▼
                           stake_rotator program
                           onchain/programs/…
```

---

## On-chain program

Instructions in `onchain/programs/stake_rotator/src/lib.rs`:

| Instruction | Caller | What it does |
| --- | --- | --- |
| `init_vault` | owner | Create vault PDA |
| `deposit_lst` | owner | Move LST into vault |
| `withdraw_lst` | owner | Pull LST out |
| `set_rotation_authority` | owner | Change bot keypair |
| `revoke_authority` | owner | Kill switch |
| `execute_rotation` | bot | Jupiter v6 swap via vault PDA |
| `claim_performance_fee` | bot | Fee priced on-chain via Sanctum calculator |

Security guarantees:
- Jupiter v6 program ID is **pinned in program code** — bot cannot redirect swaps
- `min_out_amount` slippage check enforced on-chain
- `claim_performance_fee` uses an allowlisted set of Sanctum SOL value calculators

---

## Status

**Pre-mainnet.** Outstanding before real user funds:

- [ ] Replace worker poll loop with Helius epoch-boundary webhook
- [ ] Expand bankrun tests to full state assertions
- [ ] External audit of `execute_rotation` and `claim_performance_fee`

Deploy guide: [`DEPLOY.md`](./DEPLOY.md)
