CREATE TABLE `klip_batch_jobs` (
	`id` varchar(64) NOT NULL,
	`batch_id` varchar(64) NOT NULL,
	`entry_name` varchar(512) NOT NULL,
	`project_id` varchar(64),
	`status` enum('queued','extracting','rendering','rendered','publishing','published','failed','cancelled') NOT NULL DEFAULT 'queued',
	`stage` varchar(32),
	`attempts` int NOT NULL DEFAULT 0,
	`max_attempts` int NOT NULL DEFAULT 5,
	`next_attempt_at` timestamp,
	`rendered_path` varchar(1024),
	`publish_id` varchar(64),
	`error` text,
	`locked_at` timestamp,
	`locked_by` varchar(64),
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_batch_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `klip_batches` (
	`id` varchar(64) NOT NULL,
	`owner_user_id` varchar(64),
	`template_id` varchar(64),
	`source` enum('upload','api') NOT NULL DEFAULT 'upload',
	`zip_path` varchar(1024) NOT NULL,
	`zip_bytes` double,
	`status` enum('queued','running','done','partial','failed','halted') NOT NULL DEFAULT 'queued',
	`total` int NOT NULL DEFAULT 0,
	`succeeded` int NOT NULL DEFAULT 0,
	`failed` int NOT NULL DEFAULT 0,
	`halted_reason` text,
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_batches_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `klip_settings` (
	`key` varchar(64) NOT NULL,
	`value` text NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_settings_key` PRIMARY KEY(`key`)
);
--> statement-breakpoint
ALTER TABLE `klip_batch_jobs` ADD CONSTRAINT `klip_batch_jobs_batch_id_klip_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `klip_batches`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `klip_batch_jobs` ADD CONSTRAINT `klip_batch_jobs_project_id_klip_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `klip_projects`(`id`) ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `klip_batch_jobs` ADD CONSTRAINT `klip_batch_jobs_publish_id_klip_ig_publishes_id_fk` FOREIGN KEY (`publish_id`) REFERENCES `klip_ig_publishes`(`id`) ON DELETE set null ON UPDATE no action;