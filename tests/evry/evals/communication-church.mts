import { createHmac } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { ACTOR_SPECS, byName, MEETINGS, PLANT } from "./golden-church.mts";

const id = (n: number) => `5b6d1f0e-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
export const ADDRESS_KEY = Buffer.alloc(32, 9);
export const INVITATION = id(0xc3c01);
export const REMINDER = id(0xc3c02);
const THANKS = id(0xc3c03);
export const USED_TEMPLATE = id(0xc3c11);
export const ALEX_CALL = id(0xc3c21);
const JAMIE = id(0xc3c31);
const SUPPRESSION = id(0xc3c41);
const BOUNCE = id(0xc3c42);
const RESTORE = id(0xc3c43);
const MEMBER_BOUNCE = id(0xc3c44);
const SENT_AT = "2026-11-09T14:00:00.000Z";

type Recipient = {
	name: string;
	state: "accepted" | "sent" | "unknown" | "failed" | "refused";
	result: string;
	delivered?: string;
	opened?: string;
	bounced?: true;
	refusal?: "unsubscribed";
};
export const INVITED: readonly Recipient[] = [
	{
		name: "Maria Santos",
		state: "accepted",
		result: "opened",
		delivered: "2026-11-09T14:01:00.000Z",
		opened: "2026-11-09T14:40:00.000Z",
	},
	{ name: "Mark Thompson", state: "accepted", result: "delivered", delivered: "2026-11-09T14:01:00.000Z" },
	{ name: "Jen Thompson", state: "sent", result: "sent" },
	{ name: "Roberto Garcia", state: "unknown", result: "checking" },
	{ name: "Sam Patel", state: "accepted", result: "bounced", bounced: true },
	{ name: "Elena Garcia", state: "failed", result: "failed" },
	{ name: "Casey Brooks", state: "refused", result: "unsubscribed", refusal: "unsubscribed" },
];
export const OWNER_EMAIL = "owner@example.test";
const MEMBER_EMAIL = "member@example.test";
const addressHash = (address: string) => createHmac("sha256", ADDRESS_KEY).update(address).digest("hex");

export async function seedCommunication(admin: Database) {
	const run = (q: ReturnType<typeof sql>) => admin.execute(q);
	const owner = ACTOR_SPECS.owner.account;
	await run(sql`INSERT INTO person(id,tenant_id,plant_id,display_name,city,source,created_at,stage,adult_classification,commitment_state,pipeline_position,state)
		VALUES(${JAMIE},${PLANT},${PLANT},'Jamie Ortiz','Austin','other','2026-11-02T15:00:00.000Z','prospect','unknown','unknown',901,'live')`);
	await run(sql`INSERT INTO message_template(id,plant_id,name,category,subject,body_html,body_text)
		VALUES(${USED_TEMPLATE},${PLANT},'Vision night invitation','meeting_invitation','You''re invited: Vision Night',
		'<p>Hi {{name}}, come to Vision Night on Thursday.</p>','Hi {{name}}, come to Vision Night on Thursday.')`);
	const email = (
		message: string,
		subject: string,
		meeting: string,
		state: string,
		at: string | null,
		template: string | null,
	) =>
		run(sql`INSERT INTO communication(id,plant_id,author_id,revision,state,subject,body_html,body_text,audience,meeting_id,template_id,scheduled_at,created_at)
			VALUES(${message},${PLANT},${owner},2,${state},${subject},${`<p>Hi {{name}}, ${subject}.</p>`},${`Hi {{name}}, ${subject}.`},
			'{"groups":["prospects"],"teamIds":[],"personIds":[]}'::jsonb,${meeting},${template},${at},${at ?? "2026-11-09T13:00:00.000Z"})`);
	const mail = (message: string, r: Recipient, at: string) => {
		const accepted = r.state === "accepted" || r.state === "sent";
		return run(sql`INSERT INTO mail(id,tenant_id,purpose,communication_id,recipient_person_id,logical_key,payload_hash,audience_hash,
				state,refusal,accepted_at,sent_at,delivered_at,opened_at,bounced_at,created_at)
			VALUES(overlay(overlay(md5(${message + r.name}) placing '4' from 13) placing '8' from 17)::uuid,${PLANT},'communication',${message},${byName(r.name).id},
				${`communication/${message}/${byName(r.name).id}`},'seed','seed',${r.state},${r.refusal ?? null},
				${accepted ? at : null}::timestamptz,${accepted ? at : null}::timestamptz,${r.delivered ?? null}::timestamptz,
				${r.opened ?? null}::timestamptz,${r.bounced ? at : null}::timestamptz,${at})`);
	};
	await email(INVITATION, "You're invited: Vision Night", MEETINGS.thursday, "scheduled", SENT_AT, USED_TEMPLATE);
	for (const r of INVITED) await mail(INVITATION, r, SENT_AT);
	await email(REMINDER, "Vision Night reminder", MEETINGS.thursday, "draft", null, null);
	await email(
		THANKS,
		"Thanks for coming to vision night",
		MEETINGS.lastWeek,
		"scheduled",
		"2026-11-06T15:00:00.000Z",
		null,
	);
	await mail(
		THANKS,
		{ name: "Alex Rivera", state: "accepted", result: "delivered", delivered: "2026-11-06T15:01:00.000Z" },
		"2026-11-06T15:00:00.000Z",
	);

	await run(sql`INSERT INTO contact_outcome(id,plant_id,person_id,outcome,occurred_at,recorded_at,contact_channel)
		VALUES(${ALEX_CALL},${PLANT},${byName("Alex Rivera").id},'contacted','2026-11-04T00:30:00.000Z','2026-11-04T00:35:00.000Z','phone')`);
	await run(sql`INSERT INTO audit_event(tenant_id,actor_id,action,kind,subject_type,subject_id,occurred_at,recorded_at,after_revision)
		VALUES(${PLANT},${owner},'followup.recorded','outcome','contact_outcome',${ALEX_CALL},'2026-11-04T00:35:00.000Z','2026-11-04T00:35:00.000Z',1)`);

	await run(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${BOUNCE},'seed-owner-bounce','seed-owner-bounce','bounced','2026-11-07T15:00:00.000Z','2026-11-07T15:00:00.000Z','x','{"hard_bounce":true}'::jsonb)`);
	await run(sql`INSERT INTO suppression(id,address_hash,reason,source_event_id,suppressed_at)
		VALUES(${SUPPRESSION},${addressHash(OWNER_EMAIL)},'hard_bounce',${BOUNCE},'2026-11-07T15:00:00.000Z')`);
	await run(sql`INSERT INTO provider_event(id,event_key,message_id,kind,occurred_at,received_at,payload_hash,safe_payload)
		VALUES(${MEMBER_BOUNCE},'seed-member-bounce','seed-member-bounce','bounced','2026-11-08T15:00:00.000Z','2026-11-08T15:00:00.000Z','x','{"hard_bounce":true}'::jsonb)`);
	await run(sql`INSERT INTO suppression(address_hash,reason,source_event_id,suppressed_at)
		VALUES(${addressHash(MEMBER_EMAIL)},'hard_bounce',${MEMBER_BOUNCE},'2026-11-08T15:00:00.000Z')`);
	await run(sql`INSERT INTO audit_event(id,tenant_id,actor_id,action,kind,subject_type,subject_id,reason,event_key,metadata,occurred_at,recorded_at)
		VALUES(${RESTORE},${PLANT},${owner},'mail.reconciled','suppression_clear','record',${SUPPRESSION},'My inbox was full',
			'suppress/seed-restore','{}'::jsonb,'2026-10-20T15:00:00.000Z','2026-10-20T15:00:00.000Z')`);
}
