import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRequire } from "node:module";
import { closeDatabase } from "../../../packages/db/src/client.ts";
import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { setServerEnv } from "../../support/server-env.mts";
import { fixture, password, register, signIn } from "./support.mts";

let f: Awaited<ReturnType<typeof fixture>>;
let identityWrite: typeof import("../../../apps/web/src/server/identity/index.ts").identityWrite;
const { NextRequest } = createRequire(new URL("../../../apps/web/package.json", import.meta.url))("next/server");
const { proxy } = await import("../../../apps/web/src/proxy.ts");
before(async () => {
	f = await fixture();
	setServerEnv({ ...f.previewSettings, IDENTITY_ORIGIN: f.origin });
	process.env.VERCEL = "1";
	({ identityWrite } = await import("../../../apps/web/src/server/identity/index.ts"));
});
after(async () => {
	const pools = (globalThis as { [key: symbol]: Map<string, Parameters<typeof closeDatabase>[0]> | undefined })[
		Symbol.for("everyfield.web.pools")
	];
	for (const pool of pools?.values() ?? []) await closeDatabase(pool);
	if (f) await f.close();
});

const ended = (cookie: string, page: string) =>
	[page, "/api/auth" + page].map((path) => `${cookie}=; Path=${path}; Max-Age=0; HttpOnly; SameSite=Lax`);

async function post(path: string, body: unknown, kept = "") {
	const response = await identityWrite(
		new Request(`${f.origin}/api/auth/${path}`, {
			method: "POST",
			headers: {
				host: new URL(f.origin).host,
				origin: f.origin,
				"sec-fetch-site": "same-origin",
				"content-type": "application/json",
				"x-vercel-forwarded-for": "127.0.0.51",
				...(kept ? { cookie: kept } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
	const reply: { status?: string; code?: string } = await response.clone().json();
	return { status: response.status, answer: reply.status ?? reply.code, cookies: response.headers.getSetCookie() };
}

async function mailedLink(email: string, request: string, subject: string) {
	assert.equal((await f.req(request, { email })).status, 200);
	await f.dispatch();
	const mail = f.effects.filter((v) => v.to === email && v.text.startsWith(subject)).at(-1);
	assert.ok(mail);
	return new URL(mail.text.split("\n")[2]!);
}

async function mailedProof(email: string, request: string, subject: string) {
	const proof = (await mailedLink(email, request, subject)).searchParams.get("token");
	assert.ok(proof);
	return proof;
}

const proofState = async () =>
	JSON.stringify(
		(
			await f.db.execute(
				querySql`SELECT (SELECT json_agg(v ORDER BY v.id) FROM auth_verification v) AS proofs, (SELECT count(*) FROM audit_event) AS audits, (SELECT json_agg(u.email_verified ORDER BY u.id) FROM auth_user u) AS verified`,
			)
		).rows,
	);

test("INV-proof-link: a reset link value is read from the kept cookie, a value in the body alone is refused, and a final answer ends the kept value", async () => {
	const email = "kept-reset@example.test";
	f.setIp("127.0.0.52");
	assert.equal((await register(f, email)).status, 200);
	const proof = await mailedProof(email, "request-password-reset", "Reset your password");
	const kept = `ef-reset-proof=${encodeURIComponent(proof)}`;
	const fresh = "Fixture-kept-pass-2";
	const ends = ended("ef-reset-proof", "/reset-password");

	const bodyOnly = await post("reset-password", { proof, newPassword: fresh, confirmPassword: fresh });
	assert.deepEqual([bodyOnly.status, bodyOnly.answer, bodyOnly.cookies], [400, "invalid_proof", []]);

	const unchanged = await post("reset-password", { newPassword: password, confirmPassword: password }, kept);
	assert.deepEqual([unchanged.status, unchanged.answer, unchanged.cookies], [422, "invalid_input", []]);

	const reset = await post("reset-password", { newPassword: fresh, confirmPassword: fresh }, kept);
	assert.deepEqual([reset.status, reset.answer, reset.cookies], [200, "password_reset", ends]);
	assert.equal((await signIn(f, email, fresh)).status, 200);

	const used = await post(
		"reset-password",
		{ newPassword: "Fixture-kept-pass-3", confirmPassword: "Fixture-kept-pass-3" },
		kept,
	);
	assert.deepEqual([used.status, used.answer, used.cookies], [400, "invalid_proof", ends]);
	f.setIp(null);
});

test("INV-proof-link: a verify link value is read from the kept cookie, and confirming verifies the address and ends the kept value", async () => {
	const email = "kept-verify@example.test";
	f.setIp("127.0.0.53");
	assert.equal((await register(f, email)).status, 200);
	const proof = await mailedProof(email, "send-verification-email", "Verify your email");
	const ends = ended("ef-verify-proof", "/verify-email");

	const bodyOnly = await post("verify-email", { proof });
	assert.deepEqual([bodyOnly.status, bodyOnly.answer, bodyOnly.cookies], [400, "invalid_proof", []]);

	const verified = await post("verify-email", {}, `ef-verify-proof=${encodeURIComponent(proof)}`);
	assert.deepEqual([verified.status, verified.answer, verified.cookies], [200, "email_verified", ends]);
	const row = await f.db.execute(querySql`SELECT email_verified FROM auth_user WHERE email=${email}`);
	assert.equal(row.rows[0]?.email_verified, true);

	const forged = await post("verify-email", {}, "ef-verify-proof=not-a-link-value");
	assert.deepEqual([forged.status, forged.answer, forged.cookies], [400, "invalid_proof", ends]);
	f.setIp(null);
});

test("INV-proof-link: opening a reset or verify link writes nothing and leaves the link usable", async () => {
	for (const [kind, request, subject, answer, body, done] of [
		[
			"reset",
			"request-password-reset",
			"Reset your password",
			"reset-password",
			{ newPassword: "Fixture-open-pass-2", confirmPassword: "Fixture-open-pass-2" },
			"password_reset",
		],
		["verify", "send-verification-email", "Verify your email", "verify-email", {}, "email_verified"],
	] as const) {
		const email = `opened-${kind}@example.test`;
		f.setIp(kind === "reset" ? "127.0.0.54" : "127.0.0.55");
		assert.equal((await register(f, email)).status, 200);
		const link = await mailedLink(email, request, subject);
		const before = await proofState();
		const opened = proxy(new NextRequest(link.href));
		assert.equal(opened.status, 307, kind);
		const kept = opened.headers
			.getSetCookie()
			.map((c) => c.split(";")[0]!)
			.find((c) => c.startsWith(`ef-${kind}-proof=`));
		assert.ok(kept, `${kind} link value is not kept`);
		const page = proxy(new NextRequest(new URL(opened.headers.get("location")!), { headers: { cookie: kept } }));
		assert.equal(page.status, 200, kind);
		assert.equal(await proofState(), before, `opening the ${kind} link wrote`);
		const used = await post(answer, body, kept);
		assert.deepEqual([kind, used.status, used.answer], [kind, 200, done]);
		f.setIp(null);
	}
});
