import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDatabase, type Database } from "../../../packages/db/src/client.ts";
import { setServerEnv } from "../../support/server-env.mts";
import { cookie, fixture, password, register } from "./support.mts";

let f: Awaited<ReturnType<typeof fixture>>;
let identityWrite: (request: Request) => Promise<Response>;
let endEmailChangeProofOnSessionChange: (request: Request, response: Response) => Promise<Response>;
before(async () => {
	f = await fixture();
	setServerEnv({ ...f.previewSettings, IDENTITY_ORIGIN: f.origin });
	process.env.VERCEL = "1";
	({ identityWrite } = await import("../../../apps/web/src/server/identity/index.ts"));
	({ endEmailChangeProofOnSessionChange } = await import("../../../apps/web/src/server/email-change-proof.ts"));
});
after(async () => {
	const pools = (globalThis as { [key: symbol]: Map<string, Database> | undefined })[
		Symbol.for("everyfield.web.pools")
	];
	for (const pool of pools?.values() ?? []) await closeDatabase(pool);
	if (f) await f.close();
});

const ENDED = "ef-email-change-proof=; Path=/confirm-email; Max-Age=0; HttpOnly; SameSite=Lax";

async function post(path: string, body: unknown, session = "") {
	const response = await identityWrite(
		new Request(`${f.origin}/api/auth/${path}`, {
			method: "POST",
			headers: {
				host: new URL(f.origin).host,
				origin: f.origin,
				"sec-fetch-site": "same-origin",
				"content-type": "application/json",
				"x-vercel-forwarded-for": "127.0.0.41",
				...(session ? { cookie: session } : {}),
			},
			body: JSON.stringify(body),
		}),
	);
	return { status: response.status, ended: response.headers.getSetCookie().includes(ENDED), response };
}

test("INV-proof-link: signing in elsewhere, registering or signing out ends a kept email-change proof, and signing in back to the confirm page keeps it", async () => {
	const email = "confirm-proof@example.test";
	assert.equal((await register(f, email)).status, 200);
	const back = await post("sign-in/email", { email, password, returnTo: "/confirm-email" });
	assert.deepEqual([back.status, back.ended], [200, false]);
	const elsewhere = await post("sign-in/email", { email, password, returnTo: "/overview" });
	assert.deepEqual([elsewhere.status, elsewhere.ended], [200, true]);
	const plain = await post("sign-in/email", { email, password });
	assert.deepEqual([plain.status, plain.ended], [200, true]);
	const refused = await post("sign-in/email", { email, password: "Wrong-password-1" });
	assert.deepEqual([refused.status, refused.ended], [401, false]);
	const out = await post("sign-out", {}, cookie(plain.response));
	assert.deepEqual([out.status, out.ended], [200, true]);
	const other = await post("register", {
		kind: "discovery",
		name: "Synthetic",
		email: "confirm-proof-other@example.test",
		password,
		requestKey: randomUUID(),
	});
	assert.deepEqual([other.status, other.ended], [200, true]);
});

test("INV-proof-link: a successful sign-in, registration or sign-out reply that is not JSON ends a kept email-change proof", async () => {
	for (const path of ["sign-in/email", "register", "sign-out"]) {
		const reply = await endEmailChangeProofOnSessionChange(
			new Request(`${f.origin}/api/auth/${path}`, { method: "POST" }),
			new Response("<p>done</p>", { status: 200, headers: { "content-type": "text/html" } }),
		);
		assert.deepEqual([path, reply.status, reply.headers.getSetCookie().includes(ENDED)], [path, 200, true]);
	}
});
