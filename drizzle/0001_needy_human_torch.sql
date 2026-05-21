CREATE TABLE "apy_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "apy_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"lst_symbol" text NOT NULL,
	"apy" double precision NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "position_snapshots" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "position_snapshots_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"telegram_id" bigint NOT NULL,
	"lst_symbol" text NOT NULL,
	"amount_lst" double precision NOT NULL,
	"amount_base_units" numeric(39, 0) NOT NULL,
	"sol_per_lst" double precision NOT NULL,
	"usd_per_sol" double precision NOT NULL,
	"usd_value" double precision NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rotation_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "rotation_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"telegram_id" bigint NOT NULL,
	"from_lst" text NOT NULL,
	"to_lst" text NOT NULL,
	"amount_lst_in" double precision NOT NULL,
	"usd_value_at_event" double precision NOT NULL,
	"apy_uplift_pp" double precision NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "apy_snapshots_lst_time_idx" ON "apy_snapshots" USING btree ("lst_symbol","captured_at");--> statement-breakpoint
CREATE INDEX "position_snapshots_user_lst_idx" ON "position_snapshots" USING btree ("telegram_id","lst_symbol","captured_at");--> statement-breakpoint
CREATE INDEX "rotation_events_user_idx" ON "rotation_events" USING btree ("telegram_id","occurred_at");