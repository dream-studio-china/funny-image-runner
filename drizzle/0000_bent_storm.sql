CREATE TABLE `audit_events` (
	`id` char(36) NOT NULL,
	`actor_type` enum('admin','user','worker','system') NOT NULL,
	`actor_id` varchar(128),
	`action` varchar(100) NOT NULL,
	`target_id` varchar(128),
	`metadata` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `audit_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` char(36) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`batch_id` varchar(80) NOT NULL,
	`ordinal` int NOT NULL,
	`code_hash` char(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expires_at` datetime(3),
	`redeemed_at` datetime(3),
	CONSTRAINT `invitations_id` PRIMARY KEY(`id`),
	CONSTRAINT `invitations_code_hash_uq` UNIQUE(`code_hash`),
	CONSTRAINT `invitations_batch_ordinal_uq` UNIQUE(`batch_id`,`ordinal`)
);
--> statement-breakpoint
CREATE TABLE `job_outputs` (
	`job_id` char(36) NOT NULL,
	`output_index` int NOT NULL,
	`object_key` varchar(512) NOT NULL,
	`content_type` varchar(100) NOT NULL,
	`size` int NOT NULL,
	CONSTRAINT `job_outputs_job_index_uq` UNIQUE(`job_id`,`output_index`),
	CONSTRAINT `job_outputs_object_key_uq` UNIQUE(`object_key`)
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` char(36) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`upload_id` char(36) NOT NULL,
	`idempotency_key` char(36) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`preset_id` varchar(80) NOT NULL,
	`preset_version` int NOT NULL,
	`parameters` json NOT NULL,
	`status` enum('queued','running','succeeded','failed') NOT NULL DEFAULT 'queued',
	`phase` varchar(40),
	`attempts` int NOT NULL DEFAULT 0,
	`lease_token_hash` char(64),
	`lease_until` datetime(3),
	`prompt_id` char(36),
	`error_code` varchar(80),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`finished_at` datetime(3),
	CONSTRAINT `jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `jobs_upload_uq` UNIQUE(`upload_id`),
	CONSTRAINT `jobs_user_idempotency_uq` UNIQUE(`user_id`,`idempotency_key`),
	CONSTRAINT `jobs_prompt_id_uq` UNIQUE(`prompt_id`)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` char(36) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`token_hash` char(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`expires_at` datetime(3) NOT NULL,
	`revoked_at` datetime(3),
	CONSTRAINT `sessions_id` PRIMARY KEY(`id`),
	CONSTRAINT `sessions_token_hash_uq` UNIQUE(`token_hash`)
);
--> statement-breakpoint
CREATE TABLE `uploads` (
	`id` char(36) NOT NULL,
	`user_id` varchar(64) NOT NULL,
	`object_key` varchar(512) NOT NULL,
	`content_type` varchar(100) NOT NULL,
	`declared_size` int NOT NULL,
	`expires_at` datetime(3) NOT NULL,
	`consumed_job_id` char(36),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `uploads_id` PRIMARY KEY(`id`),
	CONSTRAINT `uploads_object_key_uq` UNIQUE(`object_key`),
	CONSTRAINT `uploads_consumed_job_uq` UNIQUE(`consumed_job_id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` varchar(64) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`disabled_at` datetime(3),
	CONSTRAINT `users_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `job_outputs` ADD CONSTRAINT `job_outputs_job_id_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `jobs` ADD CONSTRAINT `jobs_upload_id_uploads_id_fk` FOREIGN KEY (`upload_id`) REFERENCES `uploads`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `uploads` ADD CONSTRAINT `uploads_user_id_users_id_fk` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `audit_events_created_idx` ON `audit_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `invitations_user_idx` ON `invitations` (`user_id`);--> statement-breakpoint
CREATE INDEX `jobs_user_created_idx` ON `jobs` (`user_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`lease_until`,`created_at`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `uploads_user_created_idx` ON `uploads` (`user_id`,`created_at`);