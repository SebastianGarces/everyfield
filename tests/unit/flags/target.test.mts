import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { main } from "../../../tools/flag/main.ts";
import { resolveTarget } from "../../../tools/flag/target.ts";

const DEV = "postgres://u:p@ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech/neondb?sslmode=require";
const PROD = "postgres://u:p@ep-gentle-dust-123456.us-east-1.aws.neon.tech/neondb";
const QA = "postgres://u:p@ep-qa-branch-a1.us-east-1.aws.neon.tech/neondb";
const neverNeon = () => {
	throw Error("neonctl must not run");
};
const saved = { ...process.env };
afterEach(() => {
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	Object.assign(process.env, saved);
});

const refusal = (fn: () => unknown) => {
	try {
		fn();
	} catch (error) {
		return (error as Error).message;
	}
	return "no refusal";
};

test("bin/flag targets the shared development database by default and never reads the production setting", () => {
	Reflect.deleteProperty(process.env, "NODE_ENV");
	Reflect.deleteProperty(process.env, "CI");
	const { args, target } = resolveTarget(
		["list"],
		{ DATABASE_URL: DEV, FLAG_PRODUCTION_DATABASE_URL: PROD },
		neverNeon,
	);
	assert.deepEqual(args, ["list"]);
	assert.equal(target.label, "the shared development database (ep-autumn-dew-b8ltidky)");
	assert.ok("url" in target && new URL(target.url).hostname.startsWith("ep-autumn-dew"));
	assert.equal(new URL("url" in target ? target.url : "").searchParams.get("sslmode"), "verify-full");
});

test("bin/flag refuses a production DATABASE_URL without --production, and --production needs its own setting outside CI", () => {
	Reflect.deleteProperty(process.env, "NODE_ENV");
	Reflect.deleteProperty(process.env, "CI");
	assert.equal(
		refusal(() => resolveTarget(["list"], { DATABASE_URL: PROD }, neverNeon)),
		"DATABASE_URL is not the shared development database, so bin/flag refuses it. Use --qa <id> for a QA branch.",
	);
	assert.equal(
		refusal(() => resolveTarget(["set", "x", "on", "--all", "--production"], { DATABASE_URL: PROD }, neverNeon)),
		"--production needs FLAG_PRODUCTION_DATABASE_URL set from Sebastian's production env (AGENTS guard 1). Nothing changed.",
	);
	assert.equal(
		refusal(() => resolveTarget(["list", "--production"], { FLAG_PRODUCTION_DATABASE_URL: DEV }, neverNeon)),
		"FLAG_PRODUCTION_DATABASE_URL does not name the production endpoint. Nothing changed.",
	);
	assert.equal(
		refusal(() =>
			resolveTarget(["list", "--production"], { CI: "true", FLAG_PRODUCTION_DATABASE_URL: PROD }, neverNeon),
		),
		"bin/flag --production never runs under CI.",
	);
	const { args, target } = resolveTarget(["list", "--production"], { FLAG_PRODUCTION_DATABASE_URL: PROD }, neverNeon);
	assert.deepEqual([args, target.label], [["list"], "the PRODUCTION database (ep-gentle-dust-123456)"]);
});

test("--qa <id> targets that QA preview's Neon branch and refuses one that serves development or production", () => {
	const asked: string[][] = [];
	const neon = (url: string) => (a: readonly string[]) => {
		asked.push([...a]);
		return { status: 0, stdout: `${url}\n` };
	};
	const { target } = resolveTarget(["show", "x", "--qa", "qa-nora-1a2b"], {}, neon(QA));
	assert.equal(target.label, "the QA branch qa-nora-1a2b (ep-qa-branch-a1)");
	assert.deepEqual(asked[0]!.slice(0, 2), ["connection-string", "qa-nora-1a2b"]);
	assert.equal(
		refusal(() => resolveTarget(["list", "--qa", "qa-x"], {}, neon(PROD))),
		"The Neon branch qa-x is not a QA branch. Nothing changed.",
	);
	assert.equal(
		refusal(() => resolveTarget(["list", "--qa", "qa-x"], {}, neon(DEV))),
		"The Neon branch qa-x is not a QA branch. Nothing changed.",
	);
	assert.equal(
		refusal(() => resolveTarget(["list", "--qa", "prod"], {}, neverNeon)),
		"prod is not a QA preview id (bin/qa list).",
	);
});

test("under CI with no flag database the nightly lister skips with one line, and --file is never attempted", async () => {
	const lines: string[] = [];
	const log = console.log;
	const error = console.error;
	console.log = (l: string) => lines.push(`out ${l}`);
	console.error = (l: string) => lines.push(`err ${l}`);
	const noEvf = () => {
		throw Error("evf must not run");
	};
	try {
		assert.equal(await main(["stale"], { CI: "true" }, { evf: noEvf, neon: neverNeon }), 0);
		assert.equal(await main(["stale", "--file"], { CI: "true" }, { evf: noEvf, neon: neverNeon }), 1);
	} finally {
		console.log = log;
		console.error = error;
	}
	assert.deepEqual(lines, [
		"out bin/flag stale: skipped, no flag database (DATABASE_URL is unset and no apps/web/.env.local was found). Nothing to list until the cutover gives CI one.",
		"err bin/flag: bin/flag needs a database: no flag database (DATABASE_URL is unset and no apps/web/.env.local was found).",
	]);
});
