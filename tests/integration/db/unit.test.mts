import test from "node:test";
import assert from "node:assert/strict";
import { canonicalTimeZone } from "../../../packages/db/src/schema/time.ts";

test("INV-calendar: stored canonical spelling resolves aliases without changing a saved instant", () => {
	assert.equal(canonicalTimeZone("US/Eastern"), "America/New_York");
	assert.equal(canonicalTimeZone("Etc/UTC"), "UTC");
	assert.equal(canonicalTimeZone("America/Chicago"), "America/Chicago");
	for (const zone of ["+04:00", "not/a-zone", "Etc/GMT+5"]) assert.throws(() => canonicalTimeZone(zone));
});

test("INV-digest: canonical text and its hash are the same bytes under every LANG/ICU locale (code unit key order)", async () => {
	const { execFileSync } = await import("node:child_process");
	const { createHash } = await import("node:crypto");
	const value = { a: 1, B: 2, Z: 3, z: 4, é: 5, ä: 6, ı: 7, nested: [{ b: 1, A: 2, ä: 3, z: 4 }] };
	const expected = '{"B":2,"Z":3,"a":1,"nested":[{"A":2,"b":1,"z":4,"ä":3}],"z":4,"ä":6,"é":5,"ı":7}';
	const module = new URL("../../../packages/domain/src/operations/canonical.ts", import.meta.url).href;
	const script = `import { canonical, hash } from ${JSON.stringify(module)};
const value = JSON.parse(process.argv[1]);
process.stdout.write(JSON.stringify({ locale: new Intl.Collator().resolvedOptions().locale, text: canonical(value), hash: hash(value) }));`;
	const runs = ["C", "en_US.UTF-8", "sv_SE.UTF-8", "tr_TR.UTF-8"].map((lang) =>
		JSON.parse(
			execFileSync(process.execPath, ["--input-type=module", "-e", script, JSON.stringify(value)], {
				env: { ...process.env, LANG: lang, LC_ALL: lang },
				encoding: "utf8",
			}),
		),
	);
	assert.ok(new Set(runs.map((r) => r.locale)).size >= 3, JSON.stringify(runs.map((r) => r.locale)));
	const digest = createHash("sha256").update(expected).digest("hex");
	for (const run of runs)
		assert.deepEqual({ text: run.text, hash: run.hash }, { text: expected, hash: digest }, run.locale);
});

test("INV-jobs: a queued job row holds identifiers, keys, state and timing, never a payload", async () => {
	const { getTableColumns } = await import("../../../packages/db/src/query.ts");
	const { job } = await import("../../../packages/db/src/schema/tables.ts");
	assert.deepEqual(Object.keys(getTableColumns(job)).sort(), [
		"attempt_count",
		"checkpoint_key",
		"claim_generation",
		"eligible_at",
		"error_code",
		"finished_at",
		"id",
		"kind",
		"lease_owner",
		"lease_until",
		"max_attempts",
		"next_attempt_at",
		"producer_key",
		"revision",
		"source_revision",
		"state",
		"subject_record_id",
		"tenant_id",
	]);
});

test("INV-token-at-rest: a column that names a token, proof or secret stores its digest, outside the listed exemptions", async () => {
	const { getTableColumns, getTableName, is, Table } = await import("../../../packages/db/src/query.ts");
	const tables = await import("../../../packages/db/src/schema/tables.ts");
	const libraryOwned = "library-owned; changing them needs an auth-library change";
	const exempt: Record<string, string> = {
		"auth_session.token": libraryOwned,
		"auth_account.access_token": libraryOwned,
		"auth_account.refresh_token": libraryOwned,
		"auth_account.id_token": libraryOwned,
		"audit_event.actor_token": "a pseudonym digest of the acting account, never a credential",
	};
	const credential = /(^|_)(tokens?|secrets?|proofs?|nonce|otp|password|passcode|credentials?|api_key|bearer)(_|$)/;
	const storesValue = new Set(["string", "json", "buffer"]);
	const raw = Object.values(tables)
		.filter((value) => is(value, Table))
		.flatMap((table) =>
			Object.values(getTableColumns(table))
				.filter((c) => storesValue.has(c.dataType) && credential.test(c.name) && !/_(hash|digest)$/.test(c.name))
				.map((c) => `${getTableName(table)}.${c.name}`),
		)
		.sort();
	assert.deepEqual(raw, Object.keys(exempt).sort());
});
