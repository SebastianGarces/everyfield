import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { sql } from "../../../../packages/db/src/query.ts";
import { authorizeDigestMail, createDigestWorker, planDigests } from "../../../../packages/domain/src/jobs/digest.ts";
import { authorizeNoticeMail, authorizeNotificationMail } from "../../../../packages/domain/src/jobs/notice-mail.ts";
import { MAIL_PASSES, runDueMail } from "../../../../packages/domain/src/jobs/mail.ts";
import { createNotificationProducer } from "../../../../packages/domain/src/notifications/index.ts";
import { createNotificationWorker } from "../../../../apps/web/src/features/notifications/worker.ts";
import { ok } from "../../../support/fixture.mts";
import { FUTURE, origin, rolesWorld, ROLES, type Role, type RolesWorld } from "./roles-world.mts";

const feed = createNotificationProducer({ optOutKey: randomBytes(32) });
const at = new Intl.DateTimeFormat("en-US", { dateStyle: "full", timeZone: "UTC" }).format(
	new Date(`${FUTURE}T00:00:00Z`),
);
const PLANNING = ["New meeting: Welcome planning", `Welcome planning is on ${at} at 6:00 PM.`];
const APPROVED = ["Connection approved: Grace Austin", "Grace Austin is now connected with your church."];
const SHARING = ["Sharing changed: Grace Austin", "What your church shares with Grace Austin changed."];
const due = (title: string) => [`Task due: ${title}`, `"${title}" is assigned to you in Everyfield.`];
const overdue = (title: string) => [`Task overdue: ${title}`, `"${title}" is assigned to you in Everyfield.`];
const RELATIONSHIP = [APPROVED, SHARING, SHARING, SHARING, SHARING];

const NOTICES: Record<Role, string[][]> = {
	owner: RELATIONSHIP,
	admin: RELATIONSHIP,
	lead: [PLANNING, due("Set out chairs"), overdue("Set out chairs")],
	member: [PLANNING, due("Print programs"), overdue("Print programs")],
	director: [],
};
const CHURCH_DIGEST = "Church digest: 2 open items, Oct 20, 2026 to Oct 26, 2026";
const DIGESTS: Record<Role, { title: string; lines: string[] } | null> = {
	owner: {
		title: CHURCH_DIGEST,
		lines: ["Overdue task, due Oct 24, 2026: Call Ben.", "Meeting on Oct 29, 2026: Orientation dinner."],
	},
	admin: {
		title: CHURCH_DIGEST,
		lines: ["Meeting on Oct 29, 2026: Orientation dinner.", "Task due Oct 30, 2026: Sign the lease."],
	},
	lead: null,
	member: null,
	director: {
		title: "Oversight digest: 2 activities, Oct 25, 2026",
		lines: ["Harvest Point: 2 activities on Oct 25, 2026."],
	},
};
const EMAILED_DIGEST: Record<Role, boolean> = {
	owner: true,
	admin: true,
	lead: false,
	member: false,
	director: false,
};
const DIGEST_IN_BELL: Record<Role, boolean> = { ...EMAILED_DIGEST, owner: false, admin: false, director: true };

let w: RolesWorld;
before(async () => {
	w = await rolesWorld("roles_notices");
	const worker = createNotificationWorker({ mail: w.mailFor(authorizeNotificationMail), origin });
	await worker.run(w.db, new Date().toISOString());
	const digests = createDigestWorker({ mail: w.mailFor(authorizeDigestMail), origin });
	for (const plant of [w.plant.id, w.hidden.id])
		for (let n = 0; n < 2; n++)
			await w.admin
				.execute(sql`INSERT INTO audit_event(tenant_id,actor_token,action,kind,subject_type,subject_id,occurred_at,reason)
				VALUES(${plant},'synthetic','people.updated','edit','record',${plant},'2026-10-25T15:00:00Z','Private care reason')`);
	await planDigests(w.db, "2026-10-25T12:00:00.000Z");
	await planDigests(w.db, "2026-10-26T13:00:00.000Z");
	await digests.run(w.db, "2026-10-26T13:00:00.000Z");
});
after(() => w?.close());

const sorted = (rows: string[][]) => rows.map((row) => row.join(" | ")).sort((a, b) => a.localeCompare(b));
const queued = async (role: Role, digest: boolean) =>
	(
		await w.rows<{ title: string; body: string }>(sql`SELECT title,safe_body AS body FROM notice
			WHERE recipient_id=${w.people[role].id} AND (category='digest')=${digest}`)
	).map((n) => [n.title, n.body]);

test("INV-roles: each role is queued and shown exactly its own notices, and a role with none gets none", async () => {
	for (const role of ROLES) assert.deepEqual(sorted(await queued(role, false)), sorted(NOTICES[role]), role);
	await w.admin.execute(
		sql`UPDATE notice SET eligible_at=clock_timestamp()-interval '1 minute' WHERE eligible_at>clock_timestamp()`,
	);
	for (const role of ROLES) {
		const { items } = ok(await feed.readFeed(w.db, await w.actor(role), {}));
		const digest = DIGESTS[role];
		const shown = digest && DIGEST_IN_BELL[role] ? [[digest.title, digest.lines.join(" ")]] : [];
		assert.deepEqual(sorted(items.map((i) => [i.title, i.body ?? ""])), sorted([...NOTICES[role], ...shown]), role);
		assert.equal(ok(await feed.readFeedPage(w.db, await w.actor(role), {})).unread, items.length, role);
	}
});

test("INV-roles: each role's digest names only its own work or the churches that share activity with it, and Members get none", async () => {
	for (const role of ROLES) {
		const digest = DIGESTS[role];
		assert.deepEqual(await queued(role, true), digest ? [[digest.title, digest.lines.join(" ")]] : [], role);
	}
});

test("INV-roles: the mail rendered for each role holds exactly its own notices and digest", async () => {
	await w.admin.execute(
		sql`UPDATE job SET eligible_at=clock_timestamp()-interval '1 second' WHERE kind='mail' AND state='ready'`,
	);
	await runDueMail(w.db, w.mailFor(authorizeNoticeMail), MAIL_PASSES.notice, 100, Infinity);
	await runDueMail(w.db, w.mailFor(authorizeDigestMail), MAIL_PASSES.digest, 100, Infinity);
	for (const role of ROLES) {
		const digest = DIGESTS[role];
		const emailed =
			digest && EMAILED_DIGEST[role]
				? [
						[
							digest.title,
							[digest.title, "", ...digest.lines, "", "Open Everyfield: https://everyfield.test/notifications"].join(
								"\n",
							),
						],
					]
				: [];
		assert.deepEqual(
			sorted(w.sentMail.filter((m) => m.to === w.people[role].email).map((m) => [m.subject, m.text])),
			sorted([...NOTICES[role], ...emailed]),
			role,
		);
	}
	assert.deepEqual([...new Set(w.sentMail.map((m) => m.to))].sort(), [
		"admin@example.test",
		"hidden-owner@example.test",
		"lead@example.test",
		"member@example.test",
		"owner@example.test",
	]);
});

test("INV-roles: the digest preview opens for the roles that receive it and is refused to the others", async () => {
	const church = async (role: Role) => feed.readPlanterDigest(w.db, await w.actor(role), { plantId: w.plant.id });
	const network = async (role: Role) =>
		feed.readOversightDigest(w.db, await w.actor(role), {
			organizationId: w.grace.id,
			organizationKind: "sending_church",
			period: "owed_catchup",
		});
	const state = (r: { status: string; error?: { code: string } }) => r.error?.code ?? r.status;
	const found = { church: {} as Record<Role, string>, network: {} as Record<Role, string> };
	for (const role of ROLES) {
		found.church[role] = state(await church(role));
		found.network[role] = state(await network(role));
	}
	const no = "access_denied";
	assert.deepEqual(found, {
		church: { owner: "ok", admin: "ok", lead: no, member: no, director: no },
		network: { owner: no, admin: no, lead: no, member: no, director: "ok" },
	});
	assert.deepEqual(ok(await network("director")).plants, [w.plant.id]);
});
