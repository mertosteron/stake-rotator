# Stake Rotator

Telegram-native, non-custodial liquid staking token (LST) auto-rotation agent on
Solana. Users bind a wallet, deposit LSTs into a vault PDA they own, and a bot
proposes (or — with explicit on-chain authorization — executes) rotations into
whichever tracked LST currently offers the best risk-adjusted APY net of swap
cost.

The program is deliberately small. The user is always one transaction away
from revoking the bot's rotation authority and walking away with their LSTs.

---

## Architecture

```
┌──────────────────┐       ┌──────────────────────┐
│   Telegram       │──────▶│   bot (grammy)       │
│   (user)         │       │   src/bot/*          │
└──────────────────┘       └──────────┬───────────┘
                                      │
                                      │ pending rotations
                                      ▼
┌──────────────────┐       ┌──────────────────────┐
│  Solana wallet   │◀─────▶│  Actions server      │
│  (Phantom etc.)  │       │  src/actions/server  │
└──────────────────┘       └──────────┬───────────┘
                                      │
                              ┌───────┴───────┐
                              │   Postgres    │
                              │  (drizzle)    │
                              └───────┬───────┘
                                      │
┌──────────────────┐       ┌──────────┴───────────┐
│ Sanctum extra-api│◀──────┤  worker (epoch tick) │
│ Jupiter swap API │       │  src/worker/index.ts │
│ Helius RPC       │       └──────────┬───────────┘
└──────────────────┘                  │
                                      ▼
                           ┌──────────────────────┐
                           │  stake_rotator       │
                           │  Anchor program      │
                           │  onchain/programs/*  │
                           └──────────────────────┘
```

Three deployable units:

| Unit               | Source                                     | Process            |
| ------------------ | ------------------------------------------ | ------------------ |
| Telegram bot       | `src/bot/`                                 | `pnpm bot`        |
| Solana Actions API | `src/actions/server.ts` (started by bot)   | (in-process)       |
| Rotation worker    | `src/worker/index.ts`                      | `pnpm worker`     |
| Anchor program     | `onchain/programs/stake_rotator/src/lib.rs`| deployed once     |

---

## Trust model

The on-chain vault has two principals:

- **Owner** (the user). Controls the vault PDA at `seeds = [b"vault", owner]`.
  Can deposit, withdraw, change `rotation_authority`, or revoke it at any time.
  Revoking sets `rotation_authority` to `Pubkey::default()` — the kill switch.
- **Rotation authority** (the bot keypair). Can call `execute_rotation`, which
  forwards an arbitrary Jupiter v6 swap instruction via `invoke_signed` with
  the vault PDA as the swap signer.

Security relies on three things:

1. The Jupiter v6 program ID is **pinned in program code** — the bot cannot
   redirect a rotation through a malicious program.
2. Every rotation includes a `min_out_amount` slippage check enforced on-chain.
3. The owner can revoke authority in a single transaction (`/revoke`).

`claim_performance_fee` does **not** trust a bot-supplied LST/SOL price. It
invokes one of an allowlisted set of Sanctum SOL Value Calculator programs and
consumes the program's return data. Allowed calculators (see
`is_allowed_sol_value_calculator` in `lib.rs`):

- SPL stake-pool calculator (jitoSOL, bSOL)
- Sanctum SPL calculator
- Sanctum SPL multi-pool calculator (INF, jupSOL, hSOL)
- Marinade calculator (mSOL)
- Lido calculator
- wSOL calculator (identity oracle for wrapped SOL legs)

---

## Tracked LSTs

Defined in `src/lsts.ts`:

| Symbol   | Mint                                            |
| -------- | ----------------------------------------------- |
| jitoSOL  | `J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn`  |
| mSOL     | `mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So`   |
| bSOL     | `bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1`   |
| INF      | `5oVNBeEEQvYi1cX3ir8Dx5n1P7pdxydbGF2X4TxVusJm`  |
| jupSOL   | `jupSoLaHXQiZZTSfEWMTRRgpnyFm8f6sZdosWBjx93v`   |
| hSOL     | `he1iusmfkpAdwvxLNGV8Y1iSbj4rUy6yMhEA3fotn9A`   |

Add a new LST by extending `LSTS` and `TRACKED_LSTS`, then verifying that
Sanctum returns an APY and a SOL/LST rate for it (`pnpm probe`).

---

## Rotation math

`src/calc.ts` ranks rotations from a single source LST into every other
tracked LST:

```
swap_cost_sol     = input_sol − output_sol  (from Jupiter quote, repriced via Sanctum SOL/LST)
apy_uplift        = dest_apy − source_apy   (in absolute APY, not basis points)
daily_uplift_sol  = output_sol × apy_uplift / 365
payback_days      = swap_cost_sol / daily_uplift_sol
recommended       = apy_uplift > 0 AND payback_days ≤ paybackDaysMax
```

Default `paybackDaysMax = 30`. The list is sorted: recommended rotations first
(by daily uplift), then non-recommended (by payback). Anything with `apy_uplift
≤ 0` has `payback_days = Infinity` and is not recommended.

---

## Telegram commands

Registered in `src/bot/index.ts` and implemented in `src/bot/commands.ts`:

| Command         | What it does                                           |
| --------------- | ------------------------------------------------------ |
| `/start`        | Register the user, show help                           |
| `/bind_wallet`  | Link a Solana pubkey to the Telegram user              |
| `/status`       | Show bound wallet, vault state, LST holdings           |
| `/init_vault`   | Create the user's vault PDA on-chain                   |
| `/deposit`      | Deposit an LST into the vault                          |
| `/withdraw`     | Withdraw an LST from the vault                         |
| `/recommend`    | Show the best rotation candidate                       |
| `/rotate`       | Build a rotation tx (Solana Action URL or base64 tx)   |
| `/revoke`       | Kill switch — revoke bot rotation authority on-chain   |

`/rotate` returns a `solana-action:` URL when `BOT_PUBLIC_HOST` is set so the
user can sign in their wallet. Without `BOT_PUBLIC_HOST`, it falls back to a
base64 unsigned transaction in chat for manual signing.

---

## Project layout

```
app/
├── src/
│   ├── bot/                  # Telegram bot (grammy)
│   │   ├── index.ts          # bot bootstrap, command registry, lifecycle
│   │   └── commands.ts       # all /command handlers
│   ├── actions/
│   │   └── server.ts         # Solana Actions HTTP server + pending-rotation store
│   ├── worker/
│   │   └── index.ts          # epoch-tick rotation executor
│   ├── db/
│   │   ├── client.ts         # postgres + drizzle client
│   │   └── schema.ts         # users, pending_rotations
│   ├── program.ts            # hand-rolled Anchor instruction client
│   ├── sanctum.ts            # Sanctum extra-api: APY + SOL value
│   ├── jupiter.ts            # Jupiter swap API quote + tx builder
│   ├── balances.ts           # wallet LST holdings via getTokenAccountsByOwner
│   ├── swap.ts               # rotation tx assembly
│   ├── calc.ts               # rotation ranking math
│   ├── recommend.ts          # CLI: print rotation candidates
│   ├── probe.ts              # CLI: print Sanctum LST snapshot
│   ├── lsts.ts               # tracked LST registry
│   ├── const.ts              # shared constants
│   └── env.ts                # typed env-var access
├── onchain/
│   ├── programs/stake_rotator/
│   │   ├── src/lib.rs        # the Anchor program
│   │   └── Cargo.toml
│   ├── tests/vault.bankrun.ts
│   ├── scripts/deploy.sh
│   └── Anchor.toml
├── drizzle/                  # generated SQL migrations
├── drizzle.config.ts
├── Dockerfile                # node:22-alpine + pnpm 10, multi-stage
├── DEPLOY.md                 # production deployment runbook
├── .env.example
└── package.json
```

---

## Stack

- **Runtime:** Node 22, pnpm 10, TypeScript 6 (executed via `tsx`)
- **Telegram:** [grammy](https://grammy.dev)
- **Solana:** `@solana/web3.js`, `@solana/spl-token`
- **DB:** Postgres via `postgres` + `drizzle-orm`
- **Program:** Anchor (Rust)
- **Data:** Sanctum extra-api (APY + SOL value), Jupiter swap API (routes), Helius RPC (balances + future epoch webhooks)

---

## Quick start (development)

```bash
# 1. Install dependencies
pnpm install

# 2. Copy and fill env
cp .env.example .env
# edit .env — minimum to run probe/recommend: HELIUS_RPC_URL
# minimum to run bot:                          + TELEGRAM_BOT_TOKEN, DATABASE_URL, ROTATION_AUTHORITY_PUBKEY
# minimum to run worker:                       + BOT_KEYPAIR_PATH

# 3. (For bot/worker) provision Postgres and run migrations
pnpm migrate

# 4. Try the read-only CLIs first — they need only HELIUS_RPC_URL
pnpm probe
pnpm recommend --source mSOL --balance 100 --payback 30

# 5. Start the bot
pnpm bot

# 6. (Separately) start the rotation worker
pnpm worker
```

---

## Scripts

| Command                | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `pnpm probe`           | Print current Sanctum APY + SOL/LST snapshot for tracked LSTs   |
| `pnpm recommend`       | Print ranked rotation candidates (`--source`, `--balance`, `--payback`) |
| `pnpm bot`             | Start the Telegram bot (and Actions server if `BOT_PUBLIC_HOST` set) |
| `pnpm worker`          | Start the epoch-tick rotation executor                          |
| `pnpm db:generate`     | Generate a new Drizzle migration from `src/db/schema.ts`        |
| `pnpm db:push`         | Push schema directly (dev / staging only — see `DEPLOY.md`)     |
| `pnpm migrate`         | Apply pending Drizzle migrations                                |
| `pnpm test:onchain`    | Run the bankrun scaffold for the Anchor program                 |
| `pnpm typecheck`       | Run `tsc --noEmit`                                              |

---

## Environment variables

Defined in `src/env.ts`. See `.env.example` for descriptions.

| Variable                      | Required for                | Default                                              |
| ----------------------------- | --------------------------- | ---------------------------------------------------- |
| `HELIUS_RPC_URL`              | probe, bot, worker          | —                                                    |
| `TELEGRAM_BOT_TOKEN`          | bot                         | —                                                    |
| `DATABASE_URL`                | bot, worker, migrate        | —                                                    |
| `ROTATION_AUTHORITY_PUBKEY`   | bot                         | —                                                    |
| `STAKE_ROTATOR_PROGRAM_ID`    | bot, worker                 | `5ra9y6YL7dqWWHGvVDQsuj4HND3DeLaea38jHEMvGoaS`       |
| `SANCTUM_API_BASE`            | optional                    | `https://extra-api.sanctum.so/v1`                    |
| `JUPITER_API_BASE`            | optional                    | `https://lite-api.jup.ag/swap/v1`                    |
| `BOT_PUBLIC_HOST`             | optional (Solana Actions)   | unset → `/rotate` returns base64 tx instead          |
| `ACTIONS_PORT`                | optional                    | `8787`                                               |
| `BOT_KEYPAIR_PATH`            | worker                      | —                                                    |
| `WORKER_TICK_MS`              | optional                    | `300000` (5 min)                                     |

---

## Database schema

Two tables (`src/db/schema.ts`):

- **`users`** — one row per Telegram user. Stores bound wallet, source LST,
  payback threshold, alerts toggle, minimum APY uplift.
- **`pending_rotations`** — short-lived (90 s TTL) record of rotations the bot
  has proposed but the user has not yet signed. Looked up by the Actions server
  when the wallet fetches the transaction.

Migrations live under `drizzle/`. The initial migration uses
`CREATE TABLE IF NOT EXISTS`; for production databases with pre-existing
tables, follow the baseline plan in `DEPLOY.md`.

---

## Anchor program

`onchain/programs/stake_rotator/src/lib.rs` — instructions:

| Instruction                  | Caller             | Purpose                                       |
| ---------------------------- | ------------------ | --------------------------------------------- |
| `init_vault`                 | owner              | Create vault PDA, set initial rotation authority |
| `deposit_lst`                | owner              | Move LST into vault token account             |
| `withdraw_lst`               | owner              | Pull LST out of vault                         |
| `set_rotation_authority`     | owner              | Change which keypair can call `execute_rotation` |
| `revoke_authority`           | owner              | Set `rotation_authority` to `Pubkey::default()` (kill switch) |
| `execute_rotation`           | rotation authority | Forward a Jupiter v6 swap signed by vault PDA |
| `claim_performance_fee`      | rotation authority | Skim fee, priced on-chain via allowlisted Sanctum calculator |

Build and deploy with the Anchor toolchain (`onchain/scripts/deploy.sh`). See
`DEPLOY.md` for one-time program-keypair generation, `declare_id!` update, and
mainnet rollout cost (~5 SOL).

---

## Deployment

See [`DEPLOY.md`](./DEPLOY.md) for the full runbook covering:

1. Anchor program deployment (devnet → mainnet)
2. Bot + Actions server (Docker + reverse proxy with TLS)
3. Worker process (Docker, mounted bot keypair)
4. Pre-flight checklist (smoke tests, RPC budget, monitoring)
5. Database migration baseline strategies
6. Outstanding pre-mainnet items (Helius epoch webhook, on-chain audit)

A `Dockerfile` (node:22-alpine, pnpm 10, multi-stage) builds a single image
that runs either service via `pnpm bot` or `pnpm worker` as the command.

---

## Status

Pre-mainnet. The on-chain Jupiter routing path, ALT loading, and on-chain
fee pricing are wired. Outstanding items before real user funds:

- Replace the worker poll loop with a Helius epoch-boundary webhook.
- Expand bankrun coverage past instruction encoding into full state assertions.
- External audit of `execute_rotation` and `claim_performance_fee` calculator
  account lists.
