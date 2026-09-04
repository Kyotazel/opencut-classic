CREATE TABLE `klip_sync_media` (
	`id` varchar(128) NOT NULL,
	`project_id` varchar(64) NOT NULL,
	`file_path` varchar(1024) NOT NULL,
	`mime` varchar(128) NOT NULL,
	`size` int NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_sync_media_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `klip_sync_projects` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`data` longtext NOT NULL,
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_sync_projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `klip_sync_media` ADD CONSTRAINT `klip_sync_media_project_id_klip_sync_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `klip_sync_projects`(`id`) ON DELETE cascade ON UPDATE no action;