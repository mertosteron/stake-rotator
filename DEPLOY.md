# Deployment — Stake Rotator

Two services to deploy: the **bot/Actions server** (long-poll Telegram + HTTP server)
and the **worker** (epoch-driven rotation executor). Plus the **Anchor program**
deployed once per cluster.

---

## 1. Anchor program (Phase 4.5)

```bash
cd program
solana-keygen new -o target/deploy/stake_rotator-keypair.json   # one-time
# Update declare_id! in programs/stake_rotator/src/lib.rs to the new pubkey,
# and STAKE_ROTATOR_PROGRAM_ID in app/src/program.ts.
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

- [ ] Postgres provisioned, `pnpm migrate` run.
- [ ] `BOT_PUBLIC_HOST` is reachable over HTTPS and serves the Actions JSON.
- [ ] Bot keypair funded with ≥ 0.1 SOL.
- [ ] `STAKE_ROTATOR_PROGRAM_ID` matches the deployed program on the target
      cluster (devnet vs mainnet — get this wrong and execute_rotation will
      no-op or fail silently).
- [ ] `users.payback_days_max` defaults reviewed — 30 days is conservative.
- [ ] Smoke-test: bind a wallet → /init_vault (TODO: not yet wired into the bot)
      → deposit 0.1 LST → /recommend → /rotate → /revoke.
- [ ] Monitoring: Sentry or simple log shipping for the bot + worker; alert on
      worker tick failures (silent worker = silent missed yield).

## 5. Known gaps before mainnet

These were **deliberately deferred** in scaffolding and must be closed before
real user funds touch the program:

1. `init_vault` / `deposit` / `withdraw` are not yet exposed as bot commands
   (only `/revoke` is). Users can't onboard end-to-end without these.
2. `buildJupiterIx` in `src/worker/index.ts` throws — wire Jupiter
   `/swap-instructions` (POST endpoint, returns programs/accounts/data) and
   forward as `remaining_accounts` to `execute_rotation`.
3. `claim_performance_fee` trusts the bot to pass `current_sol_value_per_lst`.
   Replace with on-chain Sanctum oracle read before mainnet.
4. Replace the worker's polling loop with a Helius epoch-boundary webhook
   (Phase 1.2 — never implemented in code, only in `.env.example`).
5. Bankrun tests are scaffolded but the IDL bindings are TODO. Run
   `anchor build` then wire `@coral-xyz/anchor` in `tests/vault.bankrun.ts`.
6. Performance fee accounting needs an on-chain audit before mainnet — the
   `perf_fee_bps_max` cap is the only protection against bot misbehavior.
