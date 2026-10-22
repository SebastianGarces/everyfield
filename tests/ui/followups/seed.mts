// Seeds follow-up work on the shared development database (WP-023/ui), after the People seed. Owners need a seat and a
// committed Person linked to their account (REQ-TSK-012), so the seed links the Owner and the Member to committed
// People. It finalizes two Vision meetings through the task producer's generated-work command, as meeting finalization
// does: a first-time guest whose 48 hours are still running and owned by the Member, and one past 48 hours with no
// owner. It adds a manual follow-up and a contact through the WP-023 producer.
//
//   up:   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/followups/seed.mts up
//   down: node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/followups/seed.mts down
//
// `up` reads the People fixture and writes the task IDs to $FOLLOWUPS_UI_FIXTURE (default /tmp/everyfield-followups-ui.json).
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { requestIdentity } from "../../../packages/contracts/src/common/index.ts";
import { createFollowUpWriter } from "../../../packages/domain/src/followups/index.ts";
import { auditTransaction, finishAudit, prepareWrite } from "../../../packages/domain/src/operations/writes.ts";
import { ensureMeetingObligations } from "../../../packages/domain/src/tasks/index.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixturePath } from "../setup.mjs";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

async function up() {
	const people = JSON.parse(readFileSync(fixturePath("people"), "utf8"));
	const env = await openSeedEnvironment(people.origin);
	const { admin, runtime } = env;
	const plant = { kind: "plant", id: people.plant as string } as const;
	const owner = people.owner.accountId as string;
	const member = people.member.accountId as string;
	const session = await admin.execute(sql`SELECT s.id FROM auth_session s JOIN auth_user u ON u.id = s.user_id
		WHERE u.email = 'owner@people-preview.example.test' ORDER BY s.created_at DESC LIMIT 1`);
	const ctx = { session: session.rows[0]!.id, selected: plant } as never;
	const reminders = async () => {};
	const followups = createFollowUpWriter({ reminders });

	// Eligible owners: the Member's own Person moves to the core group; the Owner gets a linked leader Person.
	await admin.execute(sql`UPDATE person SET stage='core_group', revision=revision+1
		WHERE tenant_id=${plant.id} AND linked_account_id=${member}`);
	const own = await admin.execute(
		sql`SELECT id FROM person WHERE tenant_id=${plant.id} AND linked_account_id=${owner}`,
	);
	if (own.rows.length) await admin.execute(sql`UPDATE person SET stage='leader' WHERE id=${own.rows[0]!.id}`);
	else
		await admin.execute(sql`INSERT INTO person(tenant_id,plant_id,display_name,stage,source,linked_account_id)
			VALUES(${plant.id},${plant.id},'Daniel Reyes','leader','other',${owner})`);
	await admin.execute(sql`UPDATE plant SET timezone='America/Chicago' WHERE id=${plant.id}`);

	// Two finalized Vision meetings, through the generated-work command meeting finalization runs.
	async function vision(title: string, hoursAgo: number, personId: string, assigneeId: string | null) {
		const at = new Date(Date.now() - hoursAgo * 3_600_000);
		const date = at.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
		const origin = { at: at.toISOString(), date, zone: "America/Chicago" };
		const meetingId = randomUUID();
		await admin.execute(sql`INSERT INTO meeting(id,plant_id,type,title,local_date,local_time,timezone,starts_at,resolver_version,status,attendance_revision)
			VALUES(${meetingId},${plant.id},'vision_meeting',${title},${date},'18:00','America/Chicago',${origin.at},'1','completed',1)`);
		await auditTransaction(runtime, async (tx) => {
			const identity = requestIdentity.parse({
				owner: plant,
				actorId: owner,
				operation: "meetings.finalizeAttendance",
				requestKey: randomUUID(),
				digest: "0".repeat(64),
			});
			const claim = await prepareWrite(tx, identity);
			const cmd = { ...claim, actor: { accountId: owner, plantId: plant.id } } as never as Parameters<
				typeof ensureMeetingObligations
			>[1];
			const r = await ensureMeetingObligations(tx, cmd, reminders, {
				meetings: [{ meetingId, origin, followUps: [{ personId, assigneeId }], evaluation: null }],
			} as never);
			(cmd as never as { events: unknown[] }).events.unshift({
				id: (cmd as never as { id: string }).id,
				tenant_id: plant.id,
				actor_id: owner,
				action: "meetings.finalized",
				kind: "finalize",
				subject_type: "meeting",
				subject_id: meetingId,
			});
			await finishAudit(tx, cmd as never, identity, (r as { value: unknown }).value);
			await (r as { after: () => Promise<unknown> }).after();
		});
		const task = await admin.execute(sql`SELECT t.id FROM task t JOIN obligation o ON o.id=t.obligation_id
			WHERE o.meeting_id=${meetingId} AND t.deleted_at IS NULL`);
		return task.rows[0]!.id as string;
	}
	const sara = await vision("Vision meeting #12", 20, people.people["Sara Nunez"], member);
	const leo = await vision("Vision meeting #11", 80, people.people["Leo Pratt"], null);

	const created = await runtime.transaction((tx) =>
		followups.createFollowUp(tx as never, ctx, {
			requestKey: randomUUID(),
			input: { personId: people.people["Maria Santos"], assigneeId: member },
		}),
	);
	if (created.status !== "ok") throw Error("createFollowUp: " + JSON.stringify(created));
	const contact = await runtime.transaction((tx) =>
		followups.recordOutcome(tx as never, ctx, {
			requestKey: randomUUID(),
			input: {
				target: { kind: "person", personId: people.people["Maria Santos"] },
				outcome: "contacted",
				occurredAt: "2026-09-01T17:00:00.000Z",
				channel: "phone",
				notes: "Asked about the kids' program.",
				completeTask: false,
			},
		}),
	);
	if (contact.status !== "ok") throw Error("recordOutcome: " + JSON.stringify(contact));

	const fixture = writeFixture("followups", env.schema, {
		tasks: { sara, leo, maria: (created.value as { task: { id: string } }).task.id },
	});
	await env.close();
	console.log(JSON.stringify({ schema: env.schema, fixture }));
}

const [action] = process.argv.slice(2);
if (action === "up") await up();
else if (action === "down") console.log(JSON.stringify(await dropSeed("followups")));
else throw Error("Usage: seed.mts up | down");
