// The Messages address: every state parses from its URL and writes back to the same URL (criterion 2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute, routeHref, type Route } from "../../../apps/web/src/features/communication/model.ts";

const id = "5a86c45a-0632-4ed7-bf92-ec829e7c65cc";
const cases: [string, Route][] = [
	["/communication", { kind: "history", message: null, meeting: null, person: null }],
	[`/communication?message=${id}`, { kind: "history", message: id, meeting: null, person: null }],
	[`/communication?meeting=${id}`, { kind: "history", message: null, meeting: id, person: null }],
	[`/communication?person=${id}`, { kind: "history", message: null, meeting: null, person: id }],
	["/communication?compose=new&step=who", { kind: "compose", id: "new", step: "who", handoff: null }],
	[`/communication?compose=${id}&step=review`, { kind: "compose", id, step: "review", handoff: null }],
	["/communication?view=templates", { kind: "templates", template: null }],
	[`/communication?view=templates&template=${id}`, { kind: "templates", template: id }],
	["/communication?view=templates&template=new", { kind: "templates", template: "new" }],
	["/communication?view=address", { kind: "address" }],
];

const query = (href: string) => Object.fromEntries(new URL(href, "https://x.test").searchParams);

test("AC:CASE-COM-003 every address parses to its state and writes back", () => {
	for (const [href, route] of cases) {
		assert.deepEqual(parseRoute(query(href)), route, href);
		assert.equal(routeHref(route), href);
	}
});

test("AC:CASE-COM-003 the meeting handoff address opens a new message on Write", () => {
	const route = parseRoute(query(`/communication?meeting=${id}&template=invitation&recipients=guests`));
	assert.deepEqual(route, {
		kind: "compose",
		id: "new",
		step: "write",
		handoff: { meeting: id, template: "invitation", recipients: "guests" },
	});
});

test("AC:CASE-COM-003 an unknown step falls back to Who", () => {
	assert.equal((parseRoute({ compose: "new", step: "nope" }) as { step: string }).step, "who");
});
