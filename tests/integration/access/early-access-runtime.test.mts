import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import {
	expireAccessRequests,
	exportAccessRequests,
	receiveAccessRequest,
} from "../../../packages/domain/src/early-access/index.ts";
import { database } from "./support.mts";

let db;
before(async () => {
	db = await database();
});
after(async () => {
	await db?.close();
});

const env = {
	VERCEL_ENV: "production",
	RESEND_API_KEY: "fake-provider-key",
	EMAIL_FROM: "Everyfield <hello@everyfield.app>",
	EARLY_ACCESS_EMAIL_TO: "owner@example.org",
};
const planter = {
	name: "Sam Planter",
	email: "sam@example.org",
	plant_name: "Hope Church",
	city: "Boston",
	phase: "0 · Discovery",
	sending: "Sending Church",
};
const network = {
	name: "Alex",
	email: "alex@example.org",
	organization: "Network",
	role: "Director",
	plants: "12",
	message: "Please send details.",
};

async function earlyAccessOn(pool) {
	await db.admin.execute(querySql`TRUNCATE early_access_request, early_access_attempt`);
	const mails = [];
	const resend = async (_url, init) => {
		mails.push(JSON.parse(init.body).subject);
		return Response.json({ id: `mail-${mails.length}` });
	};
	const submit = (kind, fields) => receiveAccessRequest(kind, fields, "192.0.2.1", { db: pool, fetch: resend, env });
	const submitted = [
		await submit("planter", planter),
		await submit("network", network),
		await submit("network", { ...network, email: "old@example.org" }),
		await submit("planter", planter),
	];
	const stored = (
		await db.admin.execute(
			querySql`SELECT kind, email, data->>'name' AS name, host(ip_address) AS ip, mail_id FROM early_access_request ORDER BY email`,
		)
	).rows;
	const exported = (await exportAccessRequests(pool))
		.replace(/"[0-9a-f-]{36}"/g, '"<id>"')
		.replace(/"\d{4}-\d\d-\d\dT[\d:.]+Z"/g, '"<time>"');
	await db.admin.execute(
		querySql`UPDATE early_access_request SET created_at = now() - interval '12 months 1 day' WHERE email = 'old@example.org'`,
	);
	await db.admin.execute(
		querySql`UPDATE early_access_request SET created_at = now() - interval '31 days' WHERE email = 'alex@example.org'`,
	);
	await db.admin.execute(querySql`UPDATE early_access_attempt SET created_at = now() - interval '25 hours'`);
	const expired = await expireAccessRequests(pool);
	const kept = (
		await db.admin.execute(querySql`SELECT email, host(ip_address) AS ip FROM early_access_request ORDER BY email`)
	).rows;
	const attempts = (await db.admin.execute(querySql`SELECT count(*)::int AS n FROM early_access_attempt`)).rows[0].n;
	return { submitted, mails, stored, exported, expired, kept, attempts };
}

test("INV-access: the runtime login submits, records mail, expires and exports early access exactly as the owner does", async () => {
	assert.deepEqual(
		(await db.runtime.execute(querySql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`)).rows,
		[{ rolsuper: false, rolbypassrls: false }],
	);
	const owner = await earlyAccessOn(db.admin);
	assert.deepEqual(owner.submitted, [
		{ status: "received" },
		{ status: "received" },
		{ status: "received" },
		{ status: "received" },
	]);
	assert.deepEqual(owner.mails, [
		"Everyfield early access: planter",
		"Everyfield early access: network",
		"Everyfield early access: network",
	]);
	assert.deepEqual(owner.stored, [
		{ kind: "network", email: "alex@example.org", name: "Alex", ip: "192.0.2.1", mail_id: "mail-2" },
		{ kind: "network", email: "old@example.org", name: "Alex", ip: "192.0.2.1", mail_id: "mail-3" },
		{ kind: "planter", email: "sam@example.org", name: "Sam Planter", ip: "192.0.2.1", mail_id: "mail-1" },
	]);
	assert.equal(owner.exported.split("\r\n").length, 5);
	assert.deepEqual(owner.expired, { deleted: 1, clearedIps: 1 });
	assert.deepEqual(owner.kept, [
		{ email: "alex@example.org", ip: null },
		{ email: "sam@example.org", ip: "192.0.2.1" },
	]);
	assert.equal(owner.attempts, 0);
	assert.deepEqual(await earlyAccessOn(db.runtime), owner);
});

test("INV-privileges: the runtime login cannot alter early-access structure or rewrite stored request content", async () => {
	for (const statement of [
		"UPDATE early_access_request SET data = '{}'",
		"UPDATE early_access_request SET email = email",
		"UPDATE early_access_attempt SET email = email",
		"TRUNCATE early_access_request",
		"ALTER TABLE early_access_request ADD COLUMN extra text",
	])
		await assert.rejects(db.runtime.execute(querySql.raw(statement)), (e) => e.cause?.code === "42501", statement);
	for (const statement of ["SELECT 1 FROM early_access_request", "SELECT 1 FROM early_access_attempt"])
		await assert.rejects(db.cleanup.execute(querySql.raw(statement)), (e) => e.cause?.code === "42501", statement);
});
