CREATE INDEX `clients_device_idx` ON `clients` (`device_id`);--> statement-breakpoint
CREATE INDEX `messages_target_idx` ON `messages` (`target_id`,`id`);--> statement-breakpoint
CREATE INDEX `messages_created_idx` ON `messages` (`created_at`);