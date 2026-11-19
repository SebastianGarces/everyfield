import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { checkCommand, flagProblems, repoSources } from "../../../tools/flag/check.ts";

const flag = (kind: "release" | "kill" | "ops", expires: `${number}-${number}-${number}`) =>
	({ owner: "Tests", task: "T-471", kind, default: kind === "kill", created: "2026-11-01", expires }) as const;

const declared = {
	"live-release": flag("release", "2027-01-31"),
	"expired-release": flag("release", "2026-12-31"),
	"expired-kill": flag("kill", "2026-12-31"),
	"unread-ops": flag("ops", "2027-06-30"),
	"read-by-value": flag("ops", "2027-06-30"),
	"read-only-by-declarations": flag("release", "2027-06-30"),
} as const;

const sources = [
	{ path: "apps/web/src/features/a/routes.tsx", text: `const on = await readFlag("live-release");\nreadFlag('expired-release');` },
	{ path: "apps/web/src/features/b/server.ts", text: "await readFlag(`expired-kill`)" },
	{ path: "packages/domain/src/people/x.ts", text: `(await readFlags(db, actor)).value("read-by-value")` },
	{ path: "packages/domain/src/flags/registry.ts", text: `readFlag("unread-ops"); readFlag("read-only-by-declarations")` },
	{ path: "apps/web/src/server/flags.ts", text: `readFlag("unread-ops")` },
	{ path: "apps/web/src/server/flags.types.ts", text: `readFlag("read-only-by-declarations")` },
	{ path: "apps/web/src/features/c/notes.ts", text: `const name = "unread-ops"; readFlag("unread-ops-v2");` },
];

test("the flag check fails on a release flag past its expires date and on a registry entry with no reader, naming each flag", () => {
	assert.deepEqual(flagProblems(declared, sources, "2027-01-01"), [
		"release flag expired-release expired on 2026-12-31 (owner Tests, T-471): remove it, or move expires in packages/domain/src/flags/registry.ts with the owner's word",
		'flag unread-ops has no reader left: no readFlag("unread-ops") outside the registry and flag declarations, so delete its registry entry',
		'flag read-only-by-declarations has no reader left: no readFlag("read-only-by-declarations") outside the registry and flag declarations, so delete its registry entry',
	]);
});

test("a release flag is still live on its expires date, and a kill or ops flag never expires the check", () => {
	const problems = flagProblems(declared, sources, "2026-12-31");
	assert.ok(!problems.some((p) => p.includes("expired")), problems.join("\n"));
	assert.ok(flagProblems(declared, sources, "2028-01-01").some((p) => p.startsWith("release flag live-release expired")));
	assert.ok(!flagProblems(declared, sources, "2028-01-01").some((p) => p.includes("expired-kill")));
});

test("the real registry passes the flag check on this tree today", () => {
	const root = resolve(import.meta.dirname, "../../..");
	assert.ok(repoSources(root).some((s) => s.path === "apps/web/src/features/overview/routes.tsx"));
	const lines: string[] = [];
	assert.equal(
		checkCommand(root, (l) => lines.push(l), (l) => lines.push(l)),
		0,
		lines.join("\n"),
	);
	assert.match(lines[0]!, /^flag check: \d+ flags?, no release flag past expires, every flag has a reader\.$/);
});
