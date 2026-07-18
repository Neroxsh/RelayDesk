CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`device_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`public_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_token_hash_unique` ON `clients` (`token_hash`);--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`agent_token_hash` text NOT NULL,
	`public_key` text NOT NULL,
	`code_hash` text,
	`code_expires_at` integer,
	`paired_at` integer,
	`last_seen_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `devices_agent_token_hash_unique` ON `devices` (`agent_token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `devices_code_hash_unique` ON `devices` (`code_hash`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`device_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`target_id` text NOT NULL,
	`kind` text NOT NULL,
	`envelope` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pair_attempts` (
	`bucket` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`reset_at` integer NOT NULL
);
