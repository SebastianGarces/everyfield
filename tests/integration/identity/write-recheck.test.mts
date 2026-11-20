import "../platform/setup.mts";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import { fixture, type Actor } from "../../support/fixture.mts";
import { RequestActor, type WriteTx } from "../../../packages/domain/src/access/index.ts";
import { withCommunicationWrite } from "../../../packages/domain/src/communication/index.ts";
import { withFollowUpWrite } from "../../../packages/domain/src/followups/index.ts";
import { withMeetingsWrite } from "../../../packages/domain/src/meetings/index.ts";
import { withOnboardingWrite } from "../../../packages/domain/src/onboarding/index.ts";
import { withPeopleWrite } from "../../../packages/domain/src/people/index.ts";
import { withSettingsWrite } from "../../../packages/domain/src/settings/index.ts";
import { withTaskWrite } from "../../../packages/domain/src/tasks/index.ts";
import { withTeamsWrite } from "../../../packages/domain/src/teams/index.ts";

let f: Awaited<ReturnType<typeof fixture>>;
before(async () => {
	f = await fixture({ prefix: "recheck", max: 4 });
});
after(async () => {
	await f?.close();
});

type Body = (tx: WriteTx) => Promise<{ status: "ok"; value: string }>;
const db = () => f.pools.runtime;
const writers: Record<string, (authority: RequestActor, body: Body) => Promise<unknown>> = {
	withCommunicationWrite: (a, body) => withCommunicationWrite(db(), a, body),
	withFollowUpWrite: (a, body) => withFollowUpWrite(db(), a, body),
	withMeetingsWrite: (a, body) => withMeetingsWrite(db(), a, body),
	withOnboardingWrite: (a, body) => withOnboardingWrite(db(), a, { session: a.session, selected: f.tenant }, body),
	withPeopleWrite: (a, body) => withPeopleWrite(db(), a, body),
	withSettingsWrite: (a, body) => withSettingsWrite(db(), a, { session: a.session, selected: f.tenant }, body),
	withTaskWrite: (a, body) => withTaskWrite(db(), a, body),
	withTeamsWrite: (a, body) => withTeamsWrite(db(), a, body),
};
const rename =
	(value: string): Body =>
	async (tx) => {
		await tx.execute(sql`UPDATE plant SET name=${value} WHERE id=${f.tenant.id}::uuid`);
		return { status: "ok", value };
	};

async function publicWriteWrappers() {
	const { exports } = JSON.parse(
		readFileSync(new URL("../../../packages/domain/package.json", import.meta.url), "utf8"),
	);
	const found = new Set<string>();
	for (const target of Object.values(exports as Record<string, string>)) {
		if (!/\.tsx?$/.test(target)) continue;
		const module = await import(new URL("../../../packages/domain/" + target, import.meta.url).href);
		for (const name of Object.keys(module)) if (/^with[A-Z]\w*Write$/.test(name)) found.add(name);
	}
	return [...found].sort();
}

async function resolved(session: Actor["session"]) {
	const authority = await RequestActor.resolve(f.pools.runtime, session);
	if (!(authority instanceof RequestActor)) throw Error("The session did not resolve");
	return authority;
}

const plantName = async () =>
	((await f.admin.execute(sql`SELECT name FROM plant WHERE id=${f.tenant.id}::uuid`)).rows[0] as { name: string }).name;

test("INV-authority: each shared write wrapper rechecks the seat inside its transaction, so a page's role check only decides what it offers", async (t) => {
	assert.deepEqual(
		await publicWriteWrappers(),
		Object.keys(writers).sort(),
		"every public with*Write wrapper has a row",
	);
	for (const [name, write] of Object.entries(writers))
		await t.test(name, async () => {
			const admin = await f.actor(f.tenant, "admin");
			const page = await resolved(admin.session);
			await f.admin.execute(
				sql`UPDATE seat SET role='member', revision=revision+1 WHERE account_id=${admin.id}::uuid AND ended_at IS NULL`,
			);
			const before = await plantName(),
				stale = "Stale " + randomUUID();
			const answer = (await write(page, rename(stale))) as { error?: { correlationId?: unknown } };
			assert.deepEqual(
				answer,
				{
					status: "refused",
					error: { code: "unavailable", details: {}, correlationId: answer.error?.correlationId, retry: "never" },
				},
				"the write by the role the page read answers the unavailable refusal",
			);
			assert.equal(await plantName(), before, "the write by the role the page read commits nothing");
			const current = "Current " + randomUUID();
			await write(await resolved(admin.session), rename(current));
			assert.equal(await plantName(), current, "the same write by the current seat commits");
		});
});
