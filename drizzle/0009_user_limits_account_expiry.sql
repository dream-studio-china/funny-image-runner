ALTER TABLE users
  ADD COLUMN total_job_limit INT NULL,
  ADD COLUMN daily_job_limit INT NULL,
  ADD COLUMN account_expires_at DATETIME(3) NULL,
  ADD COLUMN account_expiry_initialized TINYINT(1) NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE invitations
  ADD COLUMN account_ttl_minutes INT NULL;
--> statement-breakpoint
CREATE TABLE system_settings (
  id INT NOT NULL DEFAULT 1,
  total_job_limit INT NULL,
  daily_job_limit INT NOT NULL DEFAULT 10,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id)
);
--> statement-breakpoint
INSERT INTO system_settings (id, total_job_limit, daily_job_limit) VALUES (1, NULL, 10);
--> statement-breakpoint
ALTER TABLE users ALTER COLUMN account_expiry_initialized SET DEFAULT 0;
