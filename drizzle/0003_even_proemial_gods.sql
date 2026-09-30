CREATE TABLE `admin_sessions` (
	`id` char(36) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	CONSTRAINT `admin_sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `admin_sessions_token_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `presets` (
	`id` varchar(80) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`name` varchar(100) NOT NULL,
	`subtitle` varchar(100) NOT NULL,
	`description` varchar(500) NOT NULL,
	`image` varchar(500) NOT NULL,
	`tint` char(7) NOT NULL,
	`accent` char(7) NOT NULL,
	`tag` varchar(40) NOT NULL,
	`prompt_label` varchar(100) NOT NULL,
	`prompt_placeholder` varchar(200) NOT NULL,
	`moods` json NOT NULL,
	`enabled` boolean NOT NULL DEFAULT true,
	`worker_config` json,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `presets_id` PRIMARY KEY(`id`)
);
