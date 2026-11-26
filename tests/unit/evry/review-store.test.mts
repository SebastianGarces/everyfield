import "../runs-in/render.mjs";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mock, test } from "node:test";
import { fileURLToPath } from "node:url";

const web = createRequire(fileURLToPath(new URL("../../../apps/web/package.json", import.meta.url)));
Object.assign(globalThis, {
	window: globalThis,
	document: Object.assign(new EventTarget(), { activeElement: null }),
	HTMLIFrameElement: class {},
	IS_REACT_ACT_ENVIRONMENT: true,
});
const { createRoot } = web("react-dom/client");
const { act, createElement, StrictMode } = web("react");
const { AppRouterContext } = web("next/dist/shared/lib/app-router-context.shared-runtime");
Object.assign(globalThis.document, {
	head: { appendChild() {} },
	createElement: () => ({ appendChild() {} }),
	createTextNode: () => ({}),
});
const { useReview } = await import("../../../apps/web/src/features/evry/review/ReviewCard.tsx");

const router = { back() {}, forward() {}, refresh() {}, push() {}, replace() {}, prefetch() {} };
const ID = "11111111-1111-4111-8111-111111111111";
const review = {
	id: ID,
	conversationId: "c",
	operation: "people.updatePerson",
	revision: 1,
	digest: "d",
	expiresAt: "2026-10-21T12:10:00Z",
	approvedAt: null,
	status: "pending",
	review: {
		target: { kind: "person", id: "p", label: "Maria Santos" },
		changes: [{ field: "city", before: "Dallas", after: "Austin" }],
	},
	outcome: null,
	executing: false,
	receipt: null,
	stale: null,
	now: "2026-10-21T12:00:00Z",
};
const refused = { error: { code: "not_found", correlationId: "x", retry: "never", outcome: "refused" } };

function server(answers: Record<string, () => Response>) {
	const sent: string[] = [];
	globalThis.fetch = (async (url: string, init?: { method?: string }) => {
		const call = `${init?.method ?? "GET"} ${url.replace(`/api/evry/proposals/${ID}`, "")}`.trim();
		sent.push(call);
		return answers[call]?.() ?? Response.json(refused, { status: 403 });
	}) as typeof fetch;
	return sent;
}

type Place = {
	changed: () => boolean;
	refused: (id: string) => boolean;
	leave: (id: string) => void;
	reload: () => void;
};
const church: Place = { changed: () => false, refused: () => false, leave() {}, reload() {} };

async function show(seed: unknown, place: Place = church) {
	let card: ReturnType<typeof useReview> | undefined;
	function Card() {
		card = useReview(ID, seed as never, place);
		return null;
	}
	const root = createRoot(
		Object.assign(new EventTarget(), {
			nodeType: 1,
			nodeName: "DIV",
			tagName: "DIV",
			ownerDocument: new EventTarget(),
		}),
	);
	await act(async () =>
		root.render(
			createElement(StrictMode, null, createElement(AppRouterContext.Provider, { value: router }, createElement(Card))),
		),
	);
	return { card: () => card!, run: (step: () => unknown) => act(async () => void (await step())), root };
}

test("INV-evry-review: a card that arrives with its review shows it with no read, also under StrictMode's double mount", async () => {
	const sent = server({});
	const { card, root } = await show(review);
	assert.equal(card().view, "pending");
	assert.deepEqual(sent, []);
	await act(async () => root.unmount());
});

test("INV-evry-review: a card the conversation says is not available to you shows Not available with no read", async () => {
	const sent = server({});
	const { card, root } = await show(null);
	assert.equal(card().view, "unavailable");
	assert.deepEqual(sent, []);
	await act(async () => root.unmount());
});

test("INV-evry-review: a card shown with no review reads it once under StrictMode; a refused read shows Not available, a lost one shows Try again, which reads once more", async () => {
	const sent = server({ GET: () => Response.json(refused, { status: 403 }) });
	const gone = await show(undefined);
	assert.deepEqual(sent, ["GET"]);
	assert.equal(gone.card().view, "unavailable");
	await act(async () => gone.root.unmount());

	const lost = server({ GET: () => new Response(null, { status: 502 }) });
	const offline = await show(undefined);
	assert.deepEqual(lost, ["GET"]);
	assert.equal(offline.card().view, "lost");
	await offline.run(() => offline.card().reload());
	assert.deepEqual(lost, ["GET", "GET"]);
	await act(async () => offline.root.unmount());
});

test("INV-evry-review: an approval the server refuses, whose review then reads as refused, shows Not available", async () => {
	const sent = server({});
	const { card, run, root } = await show(review);
	await run(() => card().approve());
	assert.deepEqual(sent, ["POST /approve", "GET"]);
	assert.equal(card().view, "unavailable");
	await act(async () => root.unmount());
});

test("INV-church-changed: an approval refused because the seat moved church shows the church change, tells the panel, and reads the review no more", async () => {
	const sent = server({
		"POST /approve": () =>
			Response.json(
				{ error: { code: "church_changed", correlationId: "x", retry: "never", outcome: "refused" } },
				{ status: 409 },
			),
	});
	const calls = { leave: 0, reload: 0 };
	let refused: string | null = null;
	const place = {
		changed: () => refused !== null,
		refused: (id: string) => refused === id,
		leave: (id: string) => void (calls.leave++, (refused = id)),
		reload: () => void calls.reload++,
	};
	const { card, run, root } = await show(review, place);
	await run(() => card().approve());
	assert.deepEqual(sent, ["POST /approve"], "no re-read of the old church's review");
	assert.equal(card().view, "moved");
	assert.equal(card().notice, null);
	assert.equal(calls.leave, 1);
	await act(async () => root.unmount());

	const again = await show(undefined, place);
	assert.equal(again.card().view, "moved", "a card mounted again, as on a resize, still shows the church change");
	assert.deepEqual(sent, ["POST /approve"], "and does not read the old church's review");
	await act(async () => again.root.unmount());
});

test("INV-church-changed: a saving card stops reading its review once the panel's church changed", async (t) => {
	mock.timers.enable({ apis: ["setTimeout"] });
	t.after(() => mock.timers.reset());
	const running = { ...review, status: "approved", approvedAt: "2026-10-21T12:01:00Z", executing: true };
	const sent = server({ GET: () => Response.json(running) });
	let moved = false;
	const { card, root } = await show(running, { changed: () => moved, refused: () => false, leave() {}, reload() {} });
	assert.equal(card().view, "running");
	moved = true;
	const pastSeveralPollDelays = { steps: 20, ms: 250 };
	for (let step = 0; step < pastSeveralPollDelays.steps; step++)
		await act(async () => mock.timers.tick(pastSeveralPollDelays.ms));
	assert.deepEqual(sent, [], "no read of the old church's review after the change");
	await act(async () => root.unmount());
});

test("INV-church-changed: a card mounted after the panel's church changed, with no review in hand, reads nothing and says the church changed", async () => {
	const sent = server({ GET: () => Response.json(review) });
	const { card, root } = await show(undefined, { changed: () => true, refused: () => false, leave() {}, reload() {} });
	assert.equal(card().view, "left");
	assert.deepEqual(sent, []);
	await act(async () => root.unmount());
});
