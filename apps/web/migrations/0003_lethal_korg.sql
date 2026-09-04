CREATE TABLE `klip_ig_accounts` (
	`id` varchar(64) NOT NULL,
	`ig_user_id` varchar(64) NOT NULL,
	`username` varchar(255) NOT NULL,
	`profile_pic_url` text,
	`access_token_enc` text NOT NULL,
	`token_expires_at` timestamp,
	`status` enum('active','token_expired','disconnected') NOT NULL DEFAULT 'active',
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_ig_accounts_id` PRIMARY KEY(`id`),
	CONSTRAINT `klip_ig_accounts_ig_user_id_unique` UNIQUE(`ig_user_id`)
);
--> statement-breakpoint
CREATE TABLE `klip_ig_publish_items` (
	`id` varchar(64) NOT NULL,
	`publish_id` varchar(64) NOT NULL,
	`ig_account_id` varchar(64) NOT NULL,
	`container_id` varchar(128),
	`status` enum('queued','uploading','processing','published','failed') NOT NULL DEFAULT 'queued',
	`permalink` text,
	`error` text,
	`attempts` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `klip_ig_publish_items_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `klip_ig_publishes` (
	`id` varchar(64) NOT NULL,
	`project_id` varchar(64) NOT NULL,
	`caption` text,
	`video_path` varchar(1024) NOT NULL,
	`status` enum('processing','done','partial','failed') NOT NULL DEFAULT 'processing',
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_ig_publishes_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `klip_projects` ADD `caption` text;--> statement-breakpoint
ALTER TABLE `klip_ig_publish_items` ADD CONSTRAINT `klip_ig_publish_items_publish_id_klip_ig_publishes_id_fk` FOREIGN KEY (`publish_id`) REFERENCES `klip_ig_publishes`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `klip_ig_publish_items` ADD CONSTRAINT `klip_ig_publish_items_ig_account_id_klip_ig_accounts_id_fk` FOREIGN KEY (`ig_account_id`) REFERENCES `klip_ig_accounts`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `klip_ig_publishes` ADD CONSTRAINT `klip_ig_publishes_project_id_klip_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `klip_projects`(`id`) ON DELETE cascade ON UPDATE no action;