CREATE TABLE `klip_brand_layers` (
	`id` varchar(64) NOT NULL,
	`project_id` varchar(64) NOT NULL,
	`asset_id` varchar(64),
	`file_path` varchar(1024) NOT NULL,
	`name` varchar(255) NOT NULL,
	`kind` enum('image','video','audio') NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`x` double NOT NULL DEFAULT 0.06,
	`y` double NOT NULL DEFAULT 0.05,
	`scale` double NOT NULL DEFAULT 0.36,
	`rotate` double NOT NULL DEFAULT 0,
	`opacity` int NOT NULL DEFAULT 100,
	`full` boolean NOT NULL DEFAULT true,
	`start` double NOT NULL DEFAULT 0,
	`dur` double NOT NULL DEFAULT 0,
	`volume` double NOT NULL DEFAULT 0.35,
	`duck` boolean NOT NULL DEFAULT false,
	`z` int NOT NULL DEFAULT 0,
	`created_at` timestamp NOT NULL,
	CONSTRAINT `klip_brand_layers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `klip_media` (
	`id` varchar(64) NOT NULL,
	`kind` enum('source','brand') NOT NULL,
	`asset_kind` enum('image','video','audio'),
	`name` varchar(255) NOT NULL,
	`file_path` varchar(1024) NOT NULL,
	`width` int,
	`height` int,
	`duration` double,
	`thumbnail_path` varchar(1024),
	`created_at` timestamp NOT NULL,
	CONSTRAINT `klip_media_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `klip_projects` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`batch_id` varchar(64),
	`source_media_id` varchar(64),
	`status` varchar(32) NOT NULL DEFAULT 'ready',
	`opencut_ref` varchar(64),
	`duration` double,
	`width` int,
	`height` int,
	`fps` double,
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_projects_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `klip_brand_layers` ADD CONSTRAINT `klip_brand_layers_project_id_klip_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `klip_projects`(`id`) ON DELETE cascade ON UPDATE no action;