CREATE TABLE `workflow_configs` (
	`id` varchar(80) NOT NULL,
	`name` varchar(100) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`workflow` json NOT NULL,
	`node_mapping` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `workflow_configs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `preset_versions` ADD `workflow_config_id` varchar(80);
--> statement-breakpoint
ALTER TABLE `preset_versions` ADD `workflow_config_version` int;
