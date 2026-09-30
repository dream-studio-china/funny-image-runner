CREATE TABLE `auth_rate_limits` (
	`key_hash` char(64) NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`reset_at` datetime(3) NOT NULL,
	CONSTRAINT `auth_rate_limits_key_hash` PRIMARY KEY(`key_hash`)
);
