ALTER TABLE `invitations` ADD `issue_source` varchar(32);--> statement-breakpoint
ALTER TABLE `invitations` ADD `source_ref` char(64);--> statement-breakpoint
ALTER TABLE `invitations` ADD `code_ciphertext` text;--> statement-breakpoint
ALTER TABLE `invitations` ADD CONSTRAINT `invitations_source_ref_uq` UNIQUE(`issue_source`,`source_ref`);