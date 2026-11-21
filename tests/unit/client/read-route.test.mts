import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { test } from "node:test";
import { readsFrom, refusalAs } from "../../../apps/web/src/components/get-reads.ts";
import { defineReads } from "../../../apps/web/src/server/platform/reads.ts";

const { z } = createRequire(new URL("../../../apps/web/package.json", import.meta.url))("zod") as typeof import("zod");

const featureRefusals = {
	communication: { status: "refused", code: "access_denied" },
	notifications: { status: "refused", code: "access_denied" },
	people: { status: "refused", code: "unavailable" },
} as const;

const serve = (signedIn: boolean) => {
	const GET = defineReads(
		async () => (signedIn ? { id: "viewer" } : null),
		"access_denied",
		(read) => ({
			communication: read(z.undefined(), async () => featureRefusals.communication),
			notifications: read(z.undefined(), async () => featureRefusals.notifications),
			people: read(z.strictObject({ personId: z.string() }), async () => featureRefusals.people),
		}),
	);
	return new Promise<Server>((resolve) => {
		const server = createServer(async (req, res) => {
			const answer = await GET(new Request(`http://127.0.0.1${req.url}`));
			res.writeHead(answer.status, { "content-type": "application/json" });
			res.end(await answer.text());
		});
		server.listen(0, "127.0.0.1", () => resolve(server));
	});
};
const reader = (server: Server) =>
	readsFrom(`http://127.0.0.1:${(server.address() as { port: number }).port}/x/read`) as (
		what: string,
		input?: unknown,
	) => Promise<unknown>;
const mapped = { status: "lost" } as const;
const asLost = (read: Promise<unknown>) => refusalAs(read as Promise<{ status: string }>, () => mapped);

test("INV-reads: a feature's bare refusal on a read route reaches the screen as the feature's own refusal", async () => {
	const server = await serve(true);
	const get = reader(server);
	try {
		const answers = {
			communication: await asLost(get("communication")),
			notifications: await asLost(get("notifications")),
			people: await asLost(get("people", { personId: "p1" })),
		};
		assert.deepEqual(answers, featureRefusals);
	} finally {
		server.close();
	}
});

test("INV-reads: the route's own refusals are tagged on the wire and refusalAs replaces them", async () => {
	const signedOut = await serve(false);
	const signedIn = await serve(true);
	try {
		const wire = {
			signedOut: await reader(signedOut)("communication"),
			unknownRead: await reader(signedIn)("nothing"),
			invalidInput: await reader(signedIn)("people", { personId: 1 }),
			badJson: await fetch(
				`http://127.0.0.1:${(signedIn.address() as { port: number }).port}/x/read?what=people&in=%7B`,
			).then((r) => r.json()),
		};
		assert.deepEqual(wire, {
			signedOut: { status: "refused", code: "access_denied", route: true },
			unknownRead: { status: "refused", code: "invalid_input", route: true },
			invalidInput: { status: "refused", code: "invalid_input", route: true },
			badJson: { status: "refused", code: "invalid_input", route: true },
		});
		const replaced = await Promise.all([
			asLost(reader(signedOut)("people", { personId: "p1" })),
			asLost(reader(signedIn)("people", { personId: 1 })),
		]);
		assert.deepEqual(replaced, [mapped, mapped]);
	} finally {
		signedOut.close();
		signedIn.close();
	}
});
