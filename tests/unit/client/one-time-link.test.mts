import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const { ONE_TIME_LINK_SCRIPT } = await import("../../../apps/web/src/components/one-time-link.ts");

function arrive(href: string) {
	const url = new URL(href, "https://everyfield.test");
	const state = { kept: "entry" };
	const writes: { state: unknown; url: string }[] = [];
	const stored = new Map<string, string>();
	const window = {
		location: { pathname: url.pathname, search: url.search, hash: url.hash },
		history: {
			state,
			replaceState: (next: unknown, _unused: string, to: string) => void writes.push({ state: next, url: to }),
		},
		sessionStorage: { setItem: (key: string, value: string) => void stored.set(key, value) },
	};
	runInNewContext(ONE_TIME_LINK_SCRIPT, { window, URLSearchParams });
	return {
		address: writes.at(-1)?.url ?? null,
		writes: writes.length,
		stateKept: writes.every((write) => write.state === state),
		stored: Object.fromEntries(stored),
	};
}

test("INV-link: the script before hydration takes a one-time link value out of the address in one replace that keeps the entry's state, and keeps it in the tab only where the page reads it from there", () => {
	const cases = [
		{
			href: "/connections/respond?invitation=inv-1#abc",
			address: "/connections/respond?invitation=inv-1",
			stored: { "ef-relationship-proof/inv-1": "abc" },
		},
		{
			href: "/invitation?from=mail#proof=xyz",
			address: "/invitation?from=mail",
			stored: { "ef-invitation-proof": "xyz" },
		},
		{ href: "/reset-password?token=t1", address: "/reset-password", stored: {} },
		{ href: "/verify-email?step=2&token=t2#top", address: "/verify-email?step=2#top", stored: {} },
		{ href: "/confirm-email?token=t4", address: null, stored: {} },
		{ href: "/invitation#other=1", address: null, stored: {} },
		{ href: "/connections/respond?invitation=inv-1", address: null, stored: {} },
		{ href: "/people?token=t3#abc", address: null, stored: {} },
	];
	for (const c of cases) {
		const after = arrive(c.href);
		assert.equal(after.address, c.address, c.href);
		assert.equal(after.writes, c.address === null ? 0 : 1, c.href);
		assert.equal(after.stateKept, true, c.href);
		assert.deepEqual(after.stored, c.stored, c.href);
	}
});
