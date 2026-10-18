import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { transaction } from "../../../apps/web/src/server/platform/database.ts";
import { createMailService } from "../../../apps/web/src/server/jobs/mail.ts";
import {
	createNotificationService,
	sendDiscoveryAssociationReceipt,
} from "../../../apps/web/src/server/jobs/notifications.ts";
import { createDigestService } from "../../../apps/web/src/server/jobs/digest.ts";
import { claimDue } from "../../../apps/web/src/server/jobs/queue.ts";
import { db, runtime, tenant, setup, teardown } from "./support.mts";
const account = randomUUID(),
	org = randomUUID(),
	org2 = randomUUID();
let sent = 0;
const authorizer = async (tx, m) => {
	if (m.notice) {
		const rows =
			await tx.execute(querySql`SELECT n.source_revision,t.revision::text AS current_revision,t.assignee_id,t.status,t.deleted_at
  FROM notice n JOIN task t ON t.id=n.source_record_id WHERE n.id=${querySql.param(m.notice)} FOR SHARE OF n,t`);
		const t = rows.rows[0];
		if (t)
			return (
				t.current_revision === t.source_revision &&
				t.assignee_id === m.recipient &&
				!t.deleted_at &&
				!["complete", "no_longer_needed"].includes(t.status)
			);
	}
	const r = await tx.execute(
		querySql`SELECT id FROM account WHERE id=${querySql.param(m.recipient)} AND registration_state='active' FOR SHARE`,
	);
	return r.rowCount === 1;
};
const mail = createMailService({
	db: runtime,
	encryptionKey: randomBytes(32),
	addressKey: randomBytes(32),
	from: "no-reply@example.test",
	authorize: authorizer,
	transport: {
		send: async () => {
			sent++;
			return { kind: "accepted", id: randomUUID() };
		},
		lookup: async () => ({ kind: "unknown" }),
	},
});
const notifications = createNotificationService({
	mail,
	eligible: async (tx, v) => {
		const r = await tx.execute(
			querySql`SELECT id FROM seat WHERE account_id=${querySql.param(v.recipient)} AND (plant_id=${querySql.param(v.owner.id)} OR organization_id=${querySql.param(v.owner.id)}) AND ended_at IS NULL FOR SHARE`,
		);
		return r.rowCount === 1 ? { address: "synthetic@example.test" } : null;
	},
});
const plantOwner = { kind: "plant", id: tenant };
const task = randomUUID();
function base(revision = "1") {
	return {
		owner: plantOwner,
		recipient: account,
		source: { kind: "task", id: task, revision },
		title: "Task due",
		text: "An open task is due.",
		operation: null,
	};
}
before(async () => {
	await setup();
	const user = randomUUID();
	await db.execute(
		querySql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${querySql.param(user)},${querySql.param(user + "@example.test")},true,'Synthetic')`,
	);
	await db.execute(
		querySql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES(${querySql.param(account)},${querySql.param(user)},'active','discovery')`,
	);
	await db.execute(
		querySql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${querySql.param(account)},${querySql.param(tenant)},'owner',now())`,
	);
	await db.execute(
		querySql`INSERT INTO task(id,plant_id,title,category,priority,status,created_at,assignee_id,due_kind,due_date) VALUES(${querySql.param(task)},${querySql.param(tenant)},'Current task','general','medium','not_started',now(),${querySql.param(account)},'date_only','2026-10-19')`,
	);
	for (const id of [org, org2])
		await db.execute(
			querySql`INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES(${querySql.param(id)},'sending_network','Synthetic Org','UTC',1)`,
		);
});
after(teardown);
test("INV-notification: resync replay retains due intents and changed source cancels already-claimed obsolete mail", async () => {
	const sync = () =>
		transaction(runtime, (tx) =>
			notifications.syncTaskReminders(tx, {
				base: base(),
				due: { kind: "date_only", date: "2026-10-19", zone: "America/Chicago" },
				open: true,
				asOf: "2026-10-18T12:00:00Z",
			}),
		);
	const first = await sync();
	assert.equal(first.length, 2);
	assert.deepEqual(await sync(), first);
	assert.deepEqual(
		await transaction(runtime, (tx) =>
			notifications.syncTaskReminders(tx, {
				base: base(),
				due: { kind: "date_only", date: "2026-10-19", zone: "America/Chicago" },
				open: true,
				asOf: "2026-10-19T14:00:00Z",
			}),
		),
		first,
	);
	await db.execute(querySql`UPDATE job SET eligible_at='2026-01-01'`);
	const [claim] = await claimDue(runtime, ["mail"]);
	assert.equal(claim.kind, "mail");
	await transaction(runtime, async (tx) => {
		await tx.execute(
			querySql`UPDATE task SET status='complete',completed_at=now(),revision=2 WHERE id=${querySql.param(task)}`,
		);
		assert.deepEqual(
			await notifications.syncTaskReminders(tx, {
				base: base("2"),
				due: { kind: "undated" },
				open: false,
				asOf: "2026-10-18T12:00:00Z",
			}),
			[],
		);
	});
	const count = sent;
	assert.deepEqual(await mail.dispatch(claim), { kind: "not_dispatched" });
	assert.equal(sent, count);
	assert.deepEqual(
		(
			await db.execute(
				querySql`SELECT state FROM mail WHERE notice_id=ANY(${querySql.param(first.map((x) => x.notice))}::uuid[]) ORDER BY id`,
			)
		).rows,
		[{ state: "cancelled" }, { state: "cancelled" }],
	);
	await assert.rejects(
		transaction(runtime, (tx) =>
			notifications.enqueue(tx, {
				...base(),
				category: "task_due",
				occurrence: "due",
				eligibleAt: "2026-10-19T14:00:00Z",
			}),
		),
		/notification_source_stale/,
	);
});
test("INV-wiki: each published upstream change yields only an in-app notice, no mail or content change", async () => {
	await db.execute(querySql`UPDATE seat SET ended_at=now() WHERE account_id=${querySql.param(account)}`);
	await db.execute(
		querySql`INSERT INTO seat(account_id,organization_id,role,accepted_at) VALUES(${querySql.param(account)},${querySql.param(org)},'owner',now())`,
	);
	const article = randomUUID(),
		state = randomUUID();
	// A globally owned article is a registered record; the editable state stays in the exact org.
	await db.execute(
		querySql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${querySql.param(article)},'article',${querySql.param("synthetic-" + article)},'00000000-0000-0000-0000-000000000000')`,
	);
	await db.execute(
		querySql`INSERT INTO article_editor_state(id,organization_id,article_id,state,revision) VALUES(${querySql.param(state)},${querySql.param(org)},${querySql.param(article)},'published',1)`,
	);
	const owner = { kind: "organization", id: org, organizationKind: "sending_network" };
	const input = {
		owner,
		recipient: account,
		source: { kind: "article_editor_state", id: state, revision: "1" },
		category: "wiki_upstream_review",
		title: "Review the upstream article",
		text: "An upstream update is available.",
		operation: null,
		eligibleAt: "2026-01-01T00:00:00Z",
	};
	const a = await transaction(runtime, (tx) => notifications.enqueue(tx, { ...input, occurrence: "published-typo" }));
	const b = await transaction(runtime, (tx) =>
		notifications.enqueue(tx, { ...input, occurrence: "published-content" }),
	);
	assert.notEqual(a.notice, b.notice);
	assert.equal(a.mail, null);
	assert.equal(b.mail, null);
	assert.equal(
		(await db.execute(querySql`SELECT count(*)::int n FROM mail WHERE tenant_id=${querySql.param(org)}`)).rows[0].n,
		0,
	);
	assert.deepEqual(
		(
			await db.execute(
				querySql`SELECT state,current_revision_id,revision::text FROM article_editor_state WHERE id=${querySql.param(state)}`,
			)
		).rows[0],
		{ state: "published", current_revision_id: null, revision: "1" },
	);
	await assert.rejects(
		transaction(runtime, (tx) =>
			notifications.enqueue(tx, {
				...input,
				owner: { ...owner, organizationKind: "sending_church" },
				occurrence: "forged",
			}),
		),
		/notification_owner_mismatch/,
	);
});
test("AC:CASE-NTF-015 INV-discovery: an account who owns the exact organization receives one receipt without a phantom plant", async () => {
	await db.execute(querySql`INSERT INTO discovery(account_id) VALUES(${querySql.param(account)})`);
	const association = randomUUID(),
		operation = randomUUID();
	await db.execute(querySql`INSERT INTO affiliation(id,account_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
  VALUES(${querySql.param(association)},${querySql.param(account)},${querySql.param(org)},now(),false,false,false,false,false,false,false)`);
	await db.execute(querySql`INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,state,started_at,tool_calls,reserved_input,reserved_output,used_input,used_output)
  VALUES(${querySql.param(operation)},${querySql.param(org)},${querySql.param(account)},'associations.acceptInvitation',${querySql.param(operation)},${querySql.param("a".repeat(64))},'complete',now(),0,0,0,0,0)`);
	const input = {
		organization: org,
		account,
		operation,
		occurrence: association + "/1/accepted",
		content: { subject: "Association accepted", text: "Your association was accepted." },
		address: async () => "synthetic@example.test",
		now: "2026-01-01T00:00:00Z",
		verifyOccurrence: async (tx) => {
			const r = await tx.execute(
				querySql`SELECT a.id FROM affiliation a JOIN operation o ON o.id=${querySql.param(operation)} AND o.tenant_id=a.organization_id WHERE a.id=${querySql.param(association)} AND a.account_id=${querySql.param(account)} AND a.organization_id=${querySql.param(org)} AND a.revision=1 AND a.ended_at IS NULL FOR SHARE OF a,o`,
			);
			return r.rowCount === 1;
		},
	};
	const before = (await db.execute(querySql`SELECT count(*)::int n FROM plant`)).rows[0].n;
	const first = await transaction(runtime, (tx) => sendDiscoveryAssociationReceipt(tx, mail, input));
	assert.equal(first.length, 1);
	assert.deepEqual(await transaction(runtime, (tx) => sendDiscoveryAssociationReceipt(tx, mail, input)), first);
	assert.equal(
		(await db.execute(querySql`SELECT count(*)::int n FROM mail WHERE id=ANY(${querySql.param(first)}::uuid[])`))
			.rows[0].n,
		1,
	);
	assert.equal(
		(await db.execute(querySql`SELECT tenant_id FROM mail WHERE id=${querySql.param(first[0])}`)).rows[0].tenant_id,
		account,
	);
	assert.equal((await db.execute(querySql`SELECT count(*)::int n FROM plant`)).rows[0].n, before);
	await assert.rejects(
		transaction(runtime, (tx) =>
			sendDiscoveryAssociationReceipt(tx, mail, { ...input, verifyOccurrence: async () => false }),
		),
		/association_occurrence_unavailable/,
	);
});
test("INV-digest: one dated catch-up advances coverage only with its matching mail; no duplicate or empty mail", async () => {
	await db.execute(querySql`UPDATE seat SET ended_at=now() WHERE account_id=${querySql.param(account)}`);
	await db.execute(
		querySql`INSERT INTO seat(account_id,plant_id,role,accepted_at) VALUES(${querySql.param(account)},${querySql.param(tenant)},'owner',now())`,
	);
	await db.execute(
		querySql`UPDATE task SET status='not_started',completed_at=NULL,revision=3 WHERE id=${querySql.param(task)}`,
	);
	const digests = createDigestService({
		origin: "https://example.test",
		nativePath: (o) => (o.kind === "plant" ? "/tasks" : "/organization"),
		mail,
		eligible: async (tx, o, recipient) => {
			const r = await tx.execute(
				querySql`SELECT id FROM seat WHERE plant_id=${querySql.param(o.id)} AND account_id=${querySql.param(recipient)} AND ended_at IS NULL FOR SHARE`,
			);
			return r.rowCount ? { address: "synthetic@example.test", cadence: "weekly" } : null;
		},
		load: async (tx, o, recipient, period) => {
			const rows = await tx.execute(
				querySql`SELECT id,due_date::text AS date,title FROM task WHERE plant_id=${querySql.param(o.id)} AND assignee_id=${querySql.param(recipient)} AND status NOT IN ('complete','no_longer_needed') AND deleted_at IS NULL AND due_date<${querySql.param(period.next)}::date ORDER BY due_date,id LIMIT 100`,
			);
			return { lines: rows.rows.map((r) => ({ kind: "task", ...r })), total: rows.rowCount };
		},
	});
	await db.execute(
		querySql`INSERT INTO digest_coverage(tenant_id,recipient_id,purpose,cadence,timezone,covered_through) VALUES(${querySql.param(tenant)},${querySql.param(account)},'planter','weekly','America/Chicago','2026-09-27')`,
	);
	const result = await transaction(runtime, (tx) =>
		digests.generateOwed(tx, plantOwner, account, "2026-10-18T22:00:00Z"),
	);
	assert.deepEqual(
		{ ...result, mail: "saved" },
		{ kind: "intended", mail: "saved", start: "2026-09-28", end: "2026-10-18", total: 1, shown: 1 },
	);
	assert.deepEqual(
		await transaction(runtime, (tx) => digests.generateOwed(tx, plantOwner, account, "2026-10-18T22:00:00Z")),
		{ kind: "covered" },
	);
	assert.equal(
		(await db.execute(querySql`SELECT last_mail_id FROM digest_coverage WHERE purpose='planter'`)).rows[0].last_mail_id,
		result.mail,
	);
	await db.execute(querySql`UPDATE task SET status='complete',completed_at=now() WHERE id=${querySql.param(task)}`);
	assert.deepEqual(
		await transaction(runtime, (tx) => digests.generateOwed(tx, plantOwner, account, "2026-10-25T22:00:00Z")),
		{ kind: "empty" },
	);
	assert.equal(
		(await db.execute(querySql`SELECT covered_through::text FROM digest_coverage WHERE purpose='planter'`)).rows[0]
			.covered_through,
		"2026-10-18",
	);
});
test("INV-digest: exact organization projection refuses narrative fields and independent unshared activity sends nothing", async () => {
	for (const [id, share] of [
		[org, true],
		[org2, false],
	])
		await db.execute(querySql`INSERT INTO affiliation(plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
  VALUES(${querySql.param(tenant)},${querySql.param(id)},now(),false,false,false,false,false,${querySql.param(share)},false)`);
	const digest = createDigestService({
		origin: "https://example.test",
		nativePath: (o) => (o.kind === "plant" ? "/tasks" : "/organization"),
		mail,
		eligible: async () => ({ address: "synthetic@example.test", cadence: "daily" }),
		load: async (tx, o) => {
			const r = await tx.execute(
				querySql`SELECT id FROM affiliation WHERE organization_id=${querySql.param(o.id)} AND plant_id=${querySql.param(tenant)} AND share_activity AND ended_at IS NULL FOR SHARE`,
			);
			return {
				lines: r.rowCount ? [{ kind: "activity", date: "2026-10-17", count: 2 }] : [],
				total: r.rowCount ? 1 : 0,
			};
		},
	});
	const unshared = await transaction(runtime, (tx) =>
		digest.generateOwed(
			tx,
			{ kind: "organization", id: org2, organizationKind: "sending_network" },
			account,
			"2026-10-18T12:00:00Z",
		),
	);
	assert.deepEqual(unshared, { kind: "empty" });
	const shared = await transaction(runtime, (tx) =>
		digest.generateOwed(
			tx,
			{ kind: "organization", id: org, organizationKind: "sending_network" },
			account,
			"2026-10-18T12:00:00Z",
		),
	);
	assert.equal(shared.kind, "intended");
	const unsafe = createDigestService({
		origin: "https://example.test",
		nativePath: (o) => (o.kind === "plant" ? "/tasks" : "/organization"),
		mail,
		eligible: async () => ({ address: "synthetic@example.test", cadence: "daily" }),
		load: async () => ({
			lines: [{ kind: "task", id: task, date: "2026-10-19", title: "Hidden narrative" }],
			total: 1,
		}),
	});
	await assert.rejects(
		transaction(runtime, (tx) =>
			unsafe.generateOwed(
				tx,
				{ kind: "organization", id: org, organizationKind: "sending_network" },
				account,
				"2026-10-19T12:00:00Z",
			),
		),
		/digest_projection_denied/,
	);
});
