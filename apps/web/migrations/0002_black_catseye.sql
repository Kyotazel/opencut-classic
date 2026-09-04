CREATE TABLE `klip_brand_template_layers` (
	`id` varchar(64) NOT NULL,
	`template_id` varchar(64) NOT NULL,
	`asset_id` varchar(64),
	`file_path` varchar(1024) NOT NULL,
	`name` varchar(255) NOT NULL,
	`kind` enum('image','video','audio') NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`anchor` enum('start','main_end') NOT NULL DEFAULT 'start',
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
	CONSTRAINT `klip_brand_template_layers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `klip_brand_templates` (
	`id` varchar(64) NOT NULL,
	`name` varchar(255) NOT NULL,
	`created_at` timestamp NOT NULL,
	`updated_at` timestamp NOT NULL,
	CONSTRAINT `klip_brand_templates_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `klip_brand_template_layers` ADD CONSTRAINT `klip_brand_template_layers_template_id_klip_brand_templates_id_fk` FOREIGN KEY (`template_id`) REFERENCES `klip_brand_templates`(`id`) ON DELETE cascade ON UPDATE no action;