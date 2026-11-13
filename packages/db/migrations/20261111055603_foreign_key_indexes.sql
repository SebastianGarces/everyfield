CREATE INDEX "proposal_ref_0" ON "proposal" USING btree ("job_id","tenant_id");--> statement-breakpoint
CREATE INDEX "record_correction_ref_0" ON "record_correction" USING btree ("person_id","plant_id");--> statement-breakpoint
CREATE INDEX "relationship_invitation_ref_0" ON "relationship_invitation" USING btree ("plant_id");--> statement-breakpoint
CREATE INDEX "relationship_invitation_ref_1" ON "relationship_invitation" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "relationship_invitation_ref_2" ON "relationship_invitation" USING btree ("organization_id");