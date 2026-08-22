CREATE TYPE "public"."pix_charge_amount_type" AS ENUM('fixed', 'open');--> statement-breakpoint
CREATE TYPE "public"."pix_key_type" AS ENUM('cpf', 'cnpj', 'email', 'phone', 'random');--> statement-breakpoint
CREATE TABLE "pix_charges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pix_key_id" uuid NOT NULL,
	"amount_type" "pix_charge_amount_type" NOT NULL,
	"amount" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pix_charges_amount_matches_type" CHECK (("pix_charges"."amount_type" = 'fixed' and "pix_charges"."amount" > 0) or ("pix_charges"."amount_type" = 'open' and "pix_charges"."amount" is null))
);
--> statement-breakpoint
CREATE TABLE "pix_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"key_type" "pix_key_type" NOT NULL,
	"key_value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pix_charges" ADD CONSTRAINT "pix_charges_pix_key_id_pix_keys_id_fk" FOREIGN KEY ("pix_key_id") REFERENCES "public"."pix_keys"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pix_keys" ADD CONSTRAINT "pix_keys_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pix_keys_key_value_idx" ON "pix_keys" USING btree ("key_value");--> statement-breakpoint
CREATE INDEX "pix_keys_account_id_idx" ON "pix_keys" USING btree ("account_id");