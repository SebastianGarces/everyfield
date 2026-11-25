import { sql, type SQL } from "@everyfield/db/query";
import { audiencePeople, optedOutSql } from "@everyfield/domain/communication";
import { z } from "zod";

const GROUPS = ["all", "core_group", "launch_team", "leaders", "prospects"] as const;
export const audienceInput = z.strictObject({
	groups: z.array(z.enum(GROUPS)).max(GROUPS.length).default([]).describe("Named groups of people"),
	teamIds: z.array(z.uuid()).max(50).default([]),
	personIds: z.array(z.uuid()).max(200).default([]).describe("People ids from an earlier result"),
});
export type AudienceValue = z.infer<typeof audienceInput>;
export const audiencePerson = z.strictObject({
	id: z.uuid(),
	displayName: z.string(),
	email: z.string().nullable(),
	n: z.int(),
	optedOutAt: z.string().nullable(),
	child: z.boolean(),
	guardians: z.array(
		z.strictObject({ id: z.uuid(), displayName: z.string(), email: z.string().nullable(), optedOut: z.boolean() }),
	),
});

const LEFT_OUT_CHILD = "marked as a child";
export const ROUTED_CHILD = "sent to a parent or guardian instead";
const childReasons = sql`(${LEFT_OUT_CHILD}::text,${ROUTED_CHILD}::text)`;

export const classifiedPeople = (plantId: string, audience: AudienceValue, hashes: Record<string, string> | null) =>
	sql`people AS (
		SELECT * FROM jsonb_to_recordset(${audiencePeople(plantId, audience)})
			x(id uuid,"displayName" text,email text,child boolean,guardians jsonb)
	), hashes AS (SELECT key AS email,value AS hash FROM jsonb_each_text(${JSON.stringify(hashes ?? {})}::jsonb)),
	routes AS (
		SELECT p.id AS child,g.id,g."displayName",g.email FROM people p
		CROSS JOIN jsonb_to_recordset(p.guardians) g(id uuid,"displayName" text,email text,"optedOut" boolean)
		WHERE p.child AND btrim(coalesce(g.email,''))<>'' AND NOT g."optedOut"
	), reached AS (
		SELECT id,"displayName",email,child FROM people
		UNION SELECT r.id,r."displayName",r.email,false FROM routes r WHERE NOT EXISTS(SELECT FROM people p WHERE p.id=r.id)
	), first_pass AS (
		SELECT p.id,p."displayName" AS name,lower(btrim(coalesce(p.email,''))) AS address,
			CASE WHEN ${optedOutSql(sql`${plantId}::uuid`, sql`p.id`)} AND btrim(coalesce(p.email,''))<>'' THEN 'unsubscribed'
				WHEN p.child AND EXISTS(SELECT FROM routes r WHERE r.child=p.id) THEN ${ROUTED_CHILD}::text
				WHEN btrim(coalesce(p.email,''))='' THEN 'no_address'
				WHEN p.child THEN ${LEFT_OUT_CHILD}::text
				WHEN EXISTS(SELECT 1 FROM suppression s JOIN hashes h ON h.hash=s.address_hash
					WHERE h.email=lower(btrim(p.email)) AND s.cleared_at IS NULL) THEN 'blocked' END AS reason
		FROM reached p
	), classified AS (
		SELECT id,name,coalesce(reason,CASE WHEN row_number() OVER (PARTITION BY reason IS NULL,address ORDER BY lower(name) COLLATE "C",id)>1
			THEN 'duplicate_address' END) AS reason
		FROM first_pass
	)`;

export const recipientNames: SQL = sql`coalesce((SELECT jsonb_agg(jsonb_build_object('name',name) ORDER BY lower(name) COLLATE "C",id) FROM classified WHERE reason IS NULL),'[]'::jsonb)`;
export const leftOutPeople: SQL = sql`coalesce((SELECT jsonb_agg(jsonb_build_object('name',name,'reason',reason) ORDER BY lower(name) COLLATE "C",id) FROM classified WHERE reason IS NOT NULL),'[]'::jsonb)`;
export const leftOutIds: SQL = sql`coalesce((SELECT jsonb_agg(id) FROM classified WHERE reason IS NOT NULL AND reason NOT IN ${childReasons}
	AND id IN (SELECT id FROM people)),'[]'::jsonb)`;
export const heldCount: SQL = sql`(SELECT count(*)::int FROM classified WHERE reason NOT IN ('no_address','duplicate_address') AND reason NOT IN ${childReasons})`;
export const audienceRefusal: SQL = sql`CASE WHEN (SELECT count(*) FROM classified WHERE reason IS NULL)=0 THEN 'Nobody in this audience can get this email.' END`;
