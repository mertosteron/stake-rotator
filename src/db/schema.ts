import {
  bigint,
  boolean,
  doublePrecision,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  telegramId: bigint("telegram_id", { mode: "bigint" }).primaryKey(),
  walletPubkey: text("wallet_pubkey"),
  sourceLst: text("source_lst"),
  paybackDaysMax: integer("payback_days_max").notNull().default(30),
  alertsEnabled: boolean("alerts_enabled").notNull().default(true),
  minUpliftPp: numeric("min_uplift_pp", { precision: 6, scale: 3 })
    .notNull()
    .default("0.25"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const pendingRotations = pgTable("pending_rotations", {
  id: text("id").primaryKey(),
  telegramId: bigint("telegram_id", { mode: "bigint" }).notNull(),
  walletPubkey: text("wallet_pubkey").notNull(),
  source: text("source").notNull(),
  dest: text("dest").notNull(),
  swapTransactionBase64: text("swap_transaction_base64").notNull(),
  apyUpliftPp: doublePrecision("apy_uplift_pp").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type PendingRotationRow = typeof pendingRotations.$inferSelect;
export type NewPendingRotation = typeof pendingRotations.$inferInsert;
