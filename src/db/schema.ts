import {
  bigint,
  boolean,
  doublePrecision,
  index,
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

// Per-user, per-LST snapshots. First row for a (telegram_id, lst_symbol) pair is the
// cost basis used by /earnings to compute realized PnL.
export const positionSnapshots = pgTable(
  "position_snapshots",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    telegramId: bigint("telegram_id", { mode: "bigint" }).notNull(),
    lstSymbol: text("lst_symbol").notNull(),
    amountLst: doublePrecision("amount_lst").notNull(),
    amountBaseUnits: numeric("amount_base_units", { precision: 39, scale: 0 })
      .notNull(),
    solPerLst: doublePrecision("sol_per_lst").notNull(),
    usdPerSol: doublePrecision("usd_per_sol").notNull(),
    usdValue: doublePrecision("usd_value").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("position_snapshots_user_lst_idx").on(
      t.telegramId,
      t.lstSymbol,
      t.capturedAt,
    ),
  ],
);

// Append-only log of completed rotations. Used by /earnings for rotation history
// and rotation contribution estimates.
export const rotationEvents = pgTable(
  "rotation_events",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    telegramId: bigint("telegram_id", { mode: "bigint" }).notNull(),
    fromLst: text("from_lst").notNull(),
    toLst: text("to_lst").notNull(),
    amountLstIn: doublePrecision("amount_lst_in").notNull(),
    usdValueAtEvent: doublePrecision("usd_value_at_event").notNull(),
    apyUpliftPp: doublePrecision("apy_uplift_pp").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("rotation_events_user_idx").on(t.telegramId, t.occurredAt)],
);

// APY time series for every tracked LST. Populated by the worker; consumed by
// /earnings to compute time-weighted average APY for alternative scenarios.
export const apySnapshots = pgTable(
  "apy_snapshots",
  {
    id: bigint("id", { mode: "number" })
      .primaryKey()
      .generatedAlwaysAsIdentity(),
    lstSymbol: text("lst_symbol").notNull(),
    apy: doublePrecision("apy").notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("apy_snapshots_lst_time_idx").on(t.lstSymbol, t.capturedAt)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type PendingRotationRow = typeof pendingRotations.$inferSelect;
export type NewPendingRotation = typeof pendingRotations.$inferInsert;
export type PositionSnapshotRow = typeof positionSnapshots.$inferSelect;
export type NewPositionSnapshot = typeof positionSnapshots.$inferInsert;
export type RotationEventRow = typeof rotationEvents.$inferSelect;
export type NewRotationEvent = typeof rotationEvents.$inferInsert;
export type ApySnapshotRow = typeof apySnapshots.$inferSelect;
export type NewApySnapshot = typeof apySnapshots.$inferInsert;
