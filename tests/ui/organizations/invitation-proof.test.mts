// T-207: a relationship invitation's emailed proof travels only in the JSON body of POST /api/connections/invitation
// (rulings U1, D54 and its 2026-11-10 clarification in docs/architecture/decisions.md), never as a server-function
// argument, so no framework action log or replay payload holds it. The route's imports are stubbed: the organization
// server records every domain call, and the organizations actions module becomes a recorder of every action argument.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { respondInvitationRequest } from "../../../packages/contracts/src/organizations/index.ts";

const FEATURE = fileURLToPath(new URL("../../../apps/web/src/features/organizations/", import.meta.url));
const ORIGIN = "https://everyfield.test";
const PROOF = "Synthetic-relationship-proof-4Kd!";
const INVITATION = "8d0f5f0e-3f43-4c43-9f0b-4d3f6c2f6a11";
process.env.IDENTITY_ORIGIN = ORIGIN;

type Viewer = { kind: "signed_out" } | { kind: "unavailable" } | { kind: "viewer"; [k: string]: unknown };
type State = {
	viewer: Viewer;
	/** Every domain call the route made, with its arguments. */
	domain: unknown[][];
	/** Every server-action call any client module made, with its arguments. */
	actions: unknown[][];
};
const state: State = ((globalThis as { __relationshipInvitation?: State }).__relationshipInvitation = {
	viewer: { kind: "signed_out" },
	domain: [],
	actions: [],
});
const pair = {
	kind: "plant",
	subject: { kind: "plant", id: "p-1" },
	organization: { kind: "organization", id: "o-1" },
};
const viewer: Viewer = {
	kind: "viewer",
	viewer: { selected: pair.organization },
	authority: {},
	mount: {
		db: {},
		adapter: {
			"associations.respondInvitation": async (_tx: unknown, _s: unknown, _o: unknown, input: unknown) => {
				state.domain.push(["associations.respondInvitation", input]);
				return { status: "accepted" };
			},
		},
	},
};

const stub = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
// Every export of the real actions module, each one recording its arguments: a client module that sends the proof to
// any server function puts it in state.actions.
const actionNames = [
	...readFileSync(join(FEATURE, "actions.ts"), "utf8").matchAll(/^export async function (\w+)/gm),
].map((m) => m[1]);
const actions = stub(
	actionNames
		.map(
			(name) =>
				`export const ${name} = async (...args) => { globalThis.__relationshipInvitation.actions.push(["${name}", ...args]); return { status: "refused", code: "unavailable" }; };`,
		)
		.join("\n"),
);
const stubs: Record<string, string> = {
	"server-only": stub(""),
	"./actions": actions,
	// intent.ts holds React hooks and a parameter property Node cannot strip; real.ts needs only its Refusal.
	"./intent": stub(`export class Refusal extends Error { constructor(code) { super(code); this.code = code; } }`),
	"@/server/organizations": stub(`
		const state = globalThis.__relationshipInvitation;
		export const viewerOf = async () => { state.domain.push(["viewerOf"]); return state.viewer; };
		export const invitationFor = async (_m, _a, _v, invitationId, proof) => {
			state.domain.push(["invitationFor", invitationId, proof]);
			return proof === ${JSON.stringify(PROOF)}
				? { invitationId, revision: "1", pair: ${JSON.stringify(pair)}, inviterDescription: "Ana", expiresAt: "2026-12-01T00:00:00.000Z" }
				: null;
		};
		export const namesFor = async (_db, _v, ids) => Object.fromEntries(ids.map((id) => [id, "Name " + id]));
		export const subjectFacts = async () => ({ zone: "America/Chicago" });
		export const command = async (_m, _a, selected, body) => ({ status: "ok", value: await body({}, {}, selected) });
	`),
};
registerHooks({
	resolve: (specifier, context, next) => {
		if (specifier in stubs) return { url: stubs[specifier]!, shortCircuit: true };
		// The app imports its own modules without an extension; Next resolves them, Node needs the .ts.
		if (specifier.startsWith(".") && !/\.\w+$/.test(specifier)) return next(`${specifier}.ts`, context);
		return next(specifier, context);
	},
});

const { relationshipInvitationRoute } = await import(pathToFileURL(join(FEATURE, "invitation/handler.ts")).href);
const { readRelationshipInvitation } = await import(pathToFileURL(join(FEATURE, "invitation/client.ts")).href);
const { realRun } = await import(pathToFileURL(join(FEATURE, "real.ts")).href);

/** Posts `body` to the route as this site's own page does, unless `init` says otherwise. */
function post(body: string, init: { origin?: string | null; type?: string } = {}) {
	const headers: Record<string, string> = { "content-type": init.type ?? "application/json" };
	if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
	return relationshipInvitationRoute(
		new Request(`${ORIGIN}/api/connections/invitation`, { method: "POST", headers, body }),
	) as Promise<Response>;
}
const reset = (v: Viewer) => {
	state.viewer = v;
	state.domain.length = 0;
	state.actions.length = 0;
};
const noStore = (response: Response) => {
	assert.equal(response.headers.get("cache-control"), "private, no-store");
	assert.equal(response.headers.get("referrer-policy"), "no-referrer");
};

test("T-207: the read and the answer send the proof only in the route's body, never in an action argument", async () => {
	reset(viewer);
	const sent: { url: string; body: string }[] = [];
	const command = respondInvitationRequest.parse({
		requestKey: "relationship-respond-1",
		expectedRevision: "1",
		input: { invitationId: INVITATION, proof: PROOF, decision: "accept" },
	});
	const realFetch = globalThis.fetch;
	// The browser's fetch: a same-origin POST carries the page's Origin.
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		sent.push({ url, body: String(init.body) });
		return relationshipInvitationRoute(
			new Request(new URL(url, ORIGIN), { ...init, headers: { ...init.headers, origin: ORIGIN } }),
		);
	}) as typeof fetch;
	try {
		const read = await readRelationshipInvitation(INVITATION, PROOF);
		assert.equal(read.kind, "invitation");
		assert.deepEqual(await realRun("associations.respondInvitation", command), { status: "accepted" });
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.deepEqual(state.actions, [], "no server action was called with the relationship invitation");
	assert.ok(!JSON.stringify(state.actions).includes(PROOF));
	assert.deepEqual(
		sent.map((s) => s.url),
		["/api/connections/invitation", "/api/connections/invitation"],
	);
	assert.ok(sent.every((s) => s.body.includes(PROOF)), "both requests carry the proof in the body");
	// The route handed the domain the proof it read from the body, and the answer's command unchanged.
	assert.deepEqual(state.domain, [
		["viewerOf"],
		["invitationFor", INVITATION, PROOF],
		["viewerOf"],
		["associations.respondInvitation", command],
	]);
});

test("T-207: no organizations server function takes a relationship proof", () => {
	for (const file of readdirSync(FEATURE, { recursive: true, encoding: "utf8" })) {
		if (!/\.tsx?$/.test(file)) continue;
		// Comments may name the proof; code may not.
		const text = readFileSync(join(FEATURE, file), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, "");
		if (!/^\s*["']use server["']/.test(text)) continue;
		assert.doesNotMatch(text, /proof/i, `${file} is a server-function module and mentions the proof`);
	}
});

test("T-207: the route answers the read as the page did: signed out, unavailable or the request", async () => {
	const read = (proof: string) => post(JSON.stringify({ op: "read", invitationId: INVITATION, proof }));

	reset({ kind: "signed_out" });
	let response = await read(PROOF);
	noStore(response);
	assert.deepEqual(await response.json(), { kind: "signed_out" });

	reset({ kind: "unavailable" });
	assert.deepEqual(await (await read(PROOF)).json(), { kind: "unavailable" });

	// A wrong, expired, used or empty proof: the domain finds nothing, and the reply is the one shared refusal.
	for (const proof of ["Wrong-proof", ""]) {
		reset(viewer);
		assert.deepEqual(await (await read(proof)).json(), { kind: "unavailable" });
	}

	reset(viewer);
	response = await read(PROOF);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		kind: "invitation",
		invitation: {
			invitationId: INVITATION,
			revision: "1",
			pair,
			inviterDescription: "Ana",
			expiresAt: "2026-12-01T00:00:00.000Z",
		},
		names: { "o-1": "Name o-1", "p-1": "Name p-1" },
		zone: "America/Chicago",
	});

	// Answering signed out is refused before the domain is asked.
	reset({ kind: "signed_out" });
	response = await post(JSON.stringify({ op: "respond", command: {} }));
	assert.deepEqual(await response.json(), { status: "refused", code: "unavailable" });
	assert.deepEqual(state.domain, [["viewerOf"]]);
});

test("T-207: the route refuses other origins, other content types, oversize and off-schema bodies untouched", async () => {
	const good = JSON.stringify({ op: "read", invitationId: INVITATION, proof: PROOF });
	const cases: [string, () => Promise<Response>, number][] = [
		["no Origin", () => post(good, { origin: null }), 403],
		["another site's Origin", () => post(good, { origin: "https://evil.test" }), 403],
		["a lookalike Origin", () => post(good, { origin: `${ORIGIN}.evil.test` }), 403],
		["a form post", () => post(good, { type: "application/x-www-form-urlencoded" }), 415],
		["plain text", () => post(good, { type: "text/plain" }), 415],
		["an oversize body", () => post(JSON.stringify({ op: "read", invitationId: INVITATION, proof: "x".repeat(20000) })), 413],
		["not JSON", () => post("{op:read"), 400],
		["an unknown op", () => post(JSON.stringify({ op: "accept_seat", command: {} })), 400],
		["an extra field", () => post(JSON.stringify({ op: "read", invitationId: INVITATION, proof: PROOF, sessionId: "s" })), 400],
		["a missing proof", () => post(JSON.stringify({ op: "read", invitationId: INVITATION })), 400],
		["a non-string proof", () => post(JSON.stringify({ op: "read", invitationId: INVITATION, proof: 1 })), 400],
	];
	for (const [name, pending, status] of cases) {
		reset(viewer);
		const response = await pending();
		assert.equal(response.status, status, name);
		noStore(response);
		assert.equal((await response.json()).status, "refused", name);
		assert.deepEqual(state.domain, [], `${name} reached the domain`);
	}
});
