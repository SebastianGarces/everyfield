// WP-029's answer key. evf ac run finds markers in tools/evf/tests only, so each test here runs its marker in the real
// integration file, against the shared development database. CI runs that file itself in the db job.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const FILE = "tests/integration/communication/email-safety.test.mts";
const skip = process.env.CI === "true" ? "the CI db job runs the integration file itself" : false;

/** The worktree has no env file: the shared development database comes from the home checkout's, as evf audit reads it. */
function envFiles(): string[] {
	const common = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: repo, encoding: "utf8" }).stdout.trim();
	const home = dirname(resolve(repo, common));
	return [join(home, "apps/web/.env.local"), join(repo, "apps/web/.env.local")].map(
		(file) => `--env-file-if-exists=${file}`,
	);
}

function runMarker(marker: string): void {
	const { NODE_TEST_CONTEXT: _, ...env } = process.env;
	const r = spawnSync(
		process.execPath,
		[
			join(repo, "packages/domain/node_modules/tsx/dist/cli.mjs"),
			"--conditions=react-server",
			...envFiles(),
			"--test",
			"--test-reporter=tap",
			`--test-name-pattern=${marker}(?!\\d)`,
			FILE,
		],
		{ cwd: repo, env, encoding: "utf8", timeout: 300_000 },
	);
	const output = `${r.stdout}${r.stderr}`;
	assert.equal(r.status, 0, output.slice(-4000));
	// Node exits 0 when no test name matches.
	assert.match(output, /^# pass [1-9]/m, output.slice(-4000));
}

// The names stay literal: evf ac run finds a marker in the file text.
for (const name of [
	"AC:WP-029-1 the recipient rule is pure and each sender calls it",
	"AC:WP-029-2 only VERCEL_ENV production allows any address",
	"AC:WP-029-3 a restricted environment approves test addresses and listed full addresses only",
	"AC:WP-029-4 a typed address on a preview with a key is captured on every communication path",
	"AC:WP-029-5 a mixed batch splits and keeps message order",
	"AC:WP-029-6 cancel and time change pick capture or Resend from the message id",
	"AC:WP-029-7 refusals and capture faults never reach the provider",
	"AC:WP-029-8 queued invitation mail obeys the rule",
	"AC:WP-029-9 the guard is inside createResendTransport.send",
	"AC:WP-029-10 early access with a recipient that is not approved calls no fetch",
	"AC:WP-029-11 production sending does not change",
	"AC:WP-029-12 unknown, development and absent environments stay restricted",
	"AC:WP-029-13 only the guarded senders can reach Resend",
	"AC:WP-029-14 no variable other than VERCEL_ENV turns the guard off",
	"AC:WP-029-15 the texts state the new behavior",
] as const) {
	test(name, { skip }, () => runMarker(name.split(" ")[0]!));
}
