CREATE TABLE `workers` (
	`id` varchar(128) NOT NULL,
	`name` varchar(128) NOT NULL,
	`state` enum('starting','idle','processing','stopping') NOT NULL,
	`current_job_id` char(36),
	`last_error` varchar(80),
	`started_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	CONSTRAINT `workers_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `workers_last_seen_idx` ON `workers` (`last_seen_at`);
