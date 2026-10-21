-- WP-020: the runtime role reads and writes Vision kit items; owner cleanup removes them with their meeting.
GRANT SELECT,INSERT,UPDATE,DELETE ON meeting_kit_item TO everyfield_runtime;
--> statement-breakpoint
GRANT SELECT,UPDATE,DELETE ON meeting_kit_item TO everyfield_cleanup;
--> statement-breakpoint
-- A new kit assignee or guest inviter names a live Person, like every other current Person reference.
CREATE TRIGGER people_live_reference BEFORE INSERT OR UPDATE OF assignee_person_id ON meeting_kit_item FOR EACH ROW EXECUTE FUNCTION people_live_reference('assignee_person_id');
--> statement-breakpoint
CREATE TRIGGER people_live_inviter BEFORE INSERT OR UPDATE OF inviter_person_id ON participation FOR EACH ROW EXECUTE FUNCTION people_live_reference('inviter_person_id');
