import { sql, type SQL } from "@everyfield/db/query";
import { audiencePeople, optedOutSql } from "@everyfield/domain/communication";
import { z } from "zod";

// Who one audience reaches, as the Evry reads and reviews show it (COM-01, INH-COMMUNICATION-05). Each person is in or
// left out for one reason, in the handoff's own order: no address, unsubscribed from this church (D-284), an address the
// email service blocks, then a second person at an address someone earlier in the list already gets. A left-out person is
// passed to the handoff as `leftOut`, so the email service gets one message per address and never one for them.

const GROUPS = ["all", "core_group", "launch_team", "leaders", "prospects"] as const;
export const audienceInput = z.strictObject({
	groups: z.array(z.enum(GROUPS)).max(GROUPS.length).default([]).describe("Named groups of people"),
	teamIds: z.array(z.uuid()).max(50).default([]),
	personIds: z.array(z.uuid()).max(200).default([]).describe("People ids from an earlier result"),
});
export type AudienceValue = z.infer<typeof audienceInput>;

/**
 * The statement's `classified` table (id, name, reason): each person of the audience, with why they are left out or
 * null. `hashes` maps each lower-cased address to its suppression hash; a read has no mail keys and passes null, so it
 * cannot see a blocked address and says so in its exclusions.
 */
export const classifiedPeople = (plantId: string, audience: AudienceValue, hashes: Record<string, string> | null) =>
	sql`people AS (
		SELECT * FROM jsonb_to_recordset(${audiencePeople(plantId, audience)}) x(id uuid,"displayName" text,email text)
	), hashes AS (SELECT key AS email,value AS hash FROM jsonb_each_text(${JSON.stringify(hashes ?? {})}::jsonb)),
	first_pass AS (
		SELECT p.id,p."displayName" AS name,lower(btrim(coalesce(p.email,''))) AS address,
			CASE WHEN btrim(coalesce(p.email,''))='' THEN 'no_address'
				WHEN ${optedOutSql(sql`${plantId}::uuid`, sql`p.id`)} THEN 'unsubscribed'
				WHEN EXISTS(SELECT 1 FROM suppression s JOIN hashes h ON h.hash=s.address_hash
					WHERE h.email=lower(btrim(p.email)) AND s.cleared_at IS NULL) THEN 'blocked' END AS reason
		FROM people p
	), classified AS (
		SELECT id,name,coalesce(reason,CASE WHEN row_number() OVER (PARTITION BY reason IS NULL,address ORDER BY name,id)>1
			THEN 'duplicate_address' END) AS reason
		FROM first_pass
	)`;

/** The names who get it, in name order. */
export const recipientNames: SQL = sql`coalesce((SELECT jsonb_agg(jsonb_build_object('name',name) ORDER BY name,id) FROM classified WHERE reason IS NULL),'[]'::jsonb)`;
/** Who the review leaves out of the email and why, by name. */
export const leftOutPeople: SQL = sql`coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'reason',reason) ORDER BY name,id) FROM classified WHERE reason IS NOT NULL),'[]'::jsonb)`;
export const leftOutIds: SQL = sql`coalesce((SELECT jsonb_agg(id) FROM classified WHERE reason IS NOT NULL),'[]'::jsonb)`;
/** What the handoff would refuse about the `classified` audience, said on the review so nothing is approved in vain. */
export const audienceRefusal: SQL = sql`CASE WHEN (SELECT count(*) FROM classified WHERE reason IS NULL)=0 THEN 'Nobody in this audience can get this email.' END`;
