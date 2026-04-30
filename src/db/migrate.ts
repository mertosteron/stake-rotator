import postgres from "postgres";
import { env } from "../env.ts";

const SQL = `
CREATE TABLE IF NOT EXISTS users (
  telegram_id        BIGINT PRIMARY KEY,
  wallet_pubkey      TEXT,
  source_lst         TEXT,
  payback_days_max   INTEGER NOT NULL DEFAULT 30,
  alerts_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  min_uplift_pp      NUMERIC(6,3) NOT NULL DEFAULT 0.25,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS alerts_enabled BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS min_uplift_pp NUMERIC(6,3) NOT NULL DEFAULT 0.25;
`;

async function main() {
  const sql = postgres(env.databaseUrl(), { max: 1 });
  try {
    await sql.unsafe(SQL);
    console.log("migrate: users table ready");
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("migrate failed:", err);
  process.exit(1);
});
