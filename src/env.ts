import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function optional(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}

export const env = {
  heliusRpcUrl: () => required("HELIUS_RPC_URL"),
  telegramBotToken: () => required("TELEGRAM_BOT_TOKEN"),
  databaseUrl: () => required("DATABASE_URL"),
  sanctumApiBase: () =>
    optional("SANCTUM_API_BASE") ?? "https://extra-api.sanctum.so/v1",
  jupiterApiBase: () =>
    optional("JUPITER_API_BASE") ?? "https://lite-api.jup.ag/swap/v1",
  stakeRotatorProgramId: () =>
    optional("STAKE_ROTATOR_PROGRAM_ID") ??
    "5ra9y6YL7dqWWHGvVDQsuj4HND3DeLaea38jHEMvGoaS",
  rotationAuthorityPubkey: () => required("ROTATION_AUTHORITY_PUBKEY"),
  botPublicHost: () => optional("BOT_PUBLIC_HOST"),
  actionsPort: () => Number(optional("ACTIONS_PORT") ?? "8787"),
};
