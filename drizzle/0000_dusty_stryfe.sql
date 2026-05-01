CREATE TABLE "pending_rotations" (
	"id" text PRIMARY KEY NOT NULL,
	"telegram_id" bigint NOT NULL,
	"wallet_pubkey" text NOT NULL,
	"source" text NOT NULL,
	"dest" text NOT NULL,
	"swap_transaction_base64" text NOT NULL,
	"apy_uplift_pp" double precision NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"telegram_id" bigint PRIMARY KEY NOT NULL,
	"wallet_pubkey" text,
	"source_lst" text,
	"payback_days_max" integer DEFAULT 30 NOT NULL,
	"alerts_enabled" boolean DEFAULT true NOT NULL,
	"min_uplift_pp" numeric(6, 3) DEFAULT '0.25' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
