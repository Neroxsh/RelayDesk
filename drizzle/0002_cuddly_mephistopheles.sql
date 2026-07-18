CREATE TABLE `pending_pairs` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`phone_name` text NOT NULL,
	`public_key` text NOT NULL,
	`pair_key_hash` text NOT NULL,
	`poll_token_hash` text NOT NULL,
	`status` text NOT NULL,
	`client_id` text,
	`client_token` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`resolved_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_pairs_poll_token_hash_unique` ON `pending_pairs` (`poll_token_hash`);--> statement-breakpoint
CREATE INDEX `pending_pairs_device_idx` ON `pending_pairs` (`device_id`,`status`);--> statement-breakpoint
ALTER TABLE `devices` ADD `pair_key_hash` text;--> statement-breakpoint
CREATE UNIQUE INDEX `devices_pair_key_hash_unique` ON `devices` (`pair_key_hash`);