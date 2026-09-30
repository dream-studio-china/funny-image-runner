CREATE TABLE `preset_categories` (
	`id` varchar(80) NOT NULL,
	`name` varchar(100) NOT NULL,
	`cover_asset_id` char(36),
	`sort_order` int NOT NULL DEFAULT 0,
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `preset_categories_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `preset_categories_order_idx` ON `preset_categories` (`sort_order`,`id`);
--> statement-breakpoint
CREATE TABLE `preset_assets` (
	`id` char(36) NOT NULL,
	`object_key` varchar(512) NOT NULL,
	`content_type` varchar(100) NOT NULL,
	`size` int NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `preset_assets_id` PRIMARY KEY(`id`),
	CONSTRAINT `preset_assets_object_key_uq` UNIQUE(`object_key`)
);
--> statement-breakpoint
CREATE TABLE `preset_versions` (
	`preset_id` varchar(80) NOT NULL,
	`version` int NOT NULL,
	`workflow` json,
	`prompt` text,
	`negative_prompt` text,
	`additional` json,
	`node_mapping` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `preset_versions_id_version_uq` UNIQUE(`preset_id`,`version`)
);
--> statement-breakpoint
ALTER TABLE `presets` ADD `category_id` varchar(80) NOT NULL DEFAULT 'general';
--> statement-breakpoint
ALTER TABLE `presets` ADD `cover_asset_id` char(36);
--> statement-breakpoint
INSERT INTO `preset_categories` (`id`,`name`,`sort_order`,`enabled`) VALUES ('general','全部风格',0,true);
--> statement-breakpoint
INSERT INTO `preset_versions` (`preset_id`,`version`,`workflow`,`prompt`,`negative_prompt`,`additional`,`node_mapping`)
SELECT `id`,`version`,`worker_config`,NULL,NULL,NULL,NULL FROM `presets`;
