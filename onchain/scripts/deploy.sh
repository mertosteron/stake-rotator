#!/usr/bin/env bash
# Phase 4.5 — deploy script for the stake_rotator Anchor program.
#
# Usage:
#   ./scripts/deploy.sh devnet            # closed beta
#   ./scripts/deploy.sh mainnet-beta      # production
#
# Pre-reqs:
#   - solana CLI ≥ 1.18 with a funded keypair at ~/.config/solana/id.json
#     (devnet: ~3 SOL; mainnet: ~5 SOL for deploy + buffer rent)
#   - anchor CLI ≥ 0.30.1
#   - PROGRAM_ID keypair already generated and matching declare_id! in lib.rs
#
# After deploy: update both Anchor.toml and src/program.ts STAKE_ROTATOR_PROGRAM_ID.

set -euo pipefail

CLUSTER="${1:-}"
if [[ -z "$CLUSTER" ]]; then
  echo "usage: $0 <devnet|mainnet-beta>" >&2
  exit 1
fi

PROGRAM_KEYPAIR="${PROGRAM_KEYPAIR:-target/deploy/stake_rotator-keypair.json}"
if [[ ! -f "$PROGRAM_KEYPAIR" ]]; then
  echo "missing program keypair at $PROGRAM_KEYPAIR" >&2
  echo "run: solana-keygen new -o $PROGRAM_KEYPAIR" >&2
  exit 1
fi

PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KEYPAIR")
echo "deploying program $PROGRAM_ID to $CLUSTER..."

case "$CLUSTER" in
  devnet)        solana config set --url https://api.devnet.solana.com ;;
  mainnet-beta)  solana config set --url https://api.mainnet-beta.solana.com ;;
  *)             echo "unknown cluster: $CLUSTER" >&2; exit 1 ;;
esac

anchor build
solana program deploy \
  --program-id "$PROGRAM_KEYPAIR" \
  target/deploy/stake_rotator.so

echo
echo "deployed. update declare_id! / STAKE_ROTATOR_PROGRAM_ID to: $PROGRAM_ID"
