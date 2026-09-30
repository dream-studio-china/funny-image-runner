ALTER TABLE `uploads` ADD `deleted_at` datetime(3);
--> statement-breakpoint
ALTER TABLE `job_outputs` ADD `deleted_at` datetime(3);
--> statement-breakpoint
ALTER TABLE `preset_assets` ADD `deleted_at` datetime(3);
