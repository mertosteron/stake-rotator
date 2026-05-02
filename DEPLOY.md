# Deployment — Stake Rotator

Two services to deploy: the **bot/Actions server** (long-poll Telegram + HTTP server)
and the **worker** (epoch-driven rotation executor). Plus the **Anchor program**
deployed once per cluster.

---

## 1. Anchor program (Phase 4.5)

```bash
cd onchain
solana-keygen new -o target/deploy/stake_rotator-keypair.json   # one-time
# Update declare_id! in programs/stake_rotator/src/lib.rs to the new pubkey,
# and set STAKE_ROTATOR_PROGRAM_ID in the app service environment.
./scripts/deploy.sh devnet
# Smoke-test with the bankrun scaffold (or anchor test on devnet) before mainnet.
./scripts/deploy.sh mainnet-beta
```

Cost: ~3 SOL devnet, ~5 SOL mainnet (program rent + buffer). Keep the program
keypair safe — losing it means losing upgrade authority.

---

## 2. Bot + Actions server (Phase 4.4)

```bash
docker build -t stake-rotator:latest .
docker run -d --name stake-rotator-bot \
  --env-file .env \
  -p 8787:8787 \
  stake-rotator:latest pnpm bot
```

Behind a reverse proxy with TLS so `BOT_PUBLIC_HOST` resolves to a real HTTPS
URL (Caddy is the cheapest path; 5 lines of config). The Solana Actions spec
requires HTTPS + valid CORS — both handled by `src/actions/server.ts` plus the
proxy.

DigitalOcean droplet ($6/mo) is sufficient for the 8-week MRR target.
AWS Fargate or Fly.io equivalents work; avoid serverless (Lambda) because the
bot's long-poll loop expects a persistent process.

---

## 3. Worker (Phase 4.2)

```bash
docker run -d --name stake-rotator-worker \
  --env-file .env \
  -v /etc/stake-rotator/bot-keypair.json:/secrets/bot-keypair.json:ro \
  -e BOT_KEYPAIR_PATH=/secrets/bot-keypair.json \
  stake-rotator:latest pnpm worker
```

The bot keypair pays for tx fees (a few thousand lamports per rotation) and
signs rotations. Top up its SOL balance with a monitoring alert (Helius
webhook on `accounts` for the bot pubkey).

---

## 4. Pre-flight checklist

- [ ] Postgres provisioned; for a clean database run `pnpm migrate`, for an existing production database follow the baseline plan below first.
- [ ] `BOT_PUBLIC_HOST` is reachable over HTTPS and serves the Actions JSON.
- [ ] Bot keypair funded with ≥ 0.1 SOL.
- [ ] `ROTATION_AUTHORITY_PUBKEY` is set to the bot keypair public key before users run `/init_vault`.
- [ ] `STAKE_ROTATOR_PROGRAM_ID` environment variable matches the deployed program
      on the target cluster (devnet vs mainnet — get this wrong and
      execute_rotation will no-op or fail silently).
- [ ] `users.payback_days_max` defaults reviewed — 30 days is conservative.
- [ ] Smoke-test: bind a wallet → `/init_vault` → `/deposit jitoSOL 0.1` → `/recommend` → `/rotate` → `/withdraw jitoSOL 0.1` → `/revoke`.
- [ ] Monitoring: Sentry or simple log shipping for the bot + worker; alert on
      worker tick failures (silent worker = silent missed yield).

## 5. Database migration baseline plan

The initial Drizzle migration now uses `CREATE TABLE IF NOT EXISTS`, so a clean
DB and a DB where the exact tables already exist will not fail on table creation.
That is not a substitute for a production baseline check: if an existing table has
different columns/types/defaults, Drizzle cannot safely infer your intent.

Recommended paths:

1. **Clean DB** — run `pnpm migrate` once.
2. **Existing production DB with no app data to preserve** — point `DATABASE_URL`
   at a cloned/staging DB first, run `pnpm db:push`, inspect the generated diff,
   then run it on production during a maintenance window.
3. **Existing production DB with app data to preserve** — manually verify that
   `users` and `pending_rotations` match `src/db/schema.ts`; if they already do,
   insert a baseline row into Drizzle's migration table for `0000_dusty_stryfe`
   instead of re-running destructive DDL. If they do not, create an additive
   baseline migration (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS ...`) and test it
   on a production snapshot before deploying.

## 6. Remaining pre-mainnet checks

The original onboarding and Jupiter v0/ALT gaps are closed in code:

1. `/init_vault`, `/deposit`, and `/withdraw` are wired into the Telegram bot.
2. The worker compiles Jupiter routes into v0 transactions and loads returned
   address lookup tables instead of rejecting ALT routes.
3. `claim_performance_fee` no longer accepts a bot-supplied LST/SOL price; it
   invokes a pinned Sanctum SOL Value Calculator program on-chain and consumes its
   return data.

Still do before real user funds touch the program:

1. Replace the worker's polling loop with a Helius epoch-boundary webhook
   (Phase 1.2 — never implemented in code, only in `.env.example`).
2. Bankrun tests cover the TypeScript client instruction encoding and PDA
   derivation shape. Add full on-chain state assertions after `anchor build`
   produces an IDL and program binary in CI.
3. Performance fee accounting and each LST's required Sanctum calculator account
   list need an external on-chain audit before mainnet.
