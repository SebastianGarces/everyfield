import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkMigrations } from "../migration-safety.ts";

const TOOL = join(dirname(fileURLToPath(import.meta.url)), "..", "migration-safety.ts");
const FILE = "packages/db/migrations/20261118000000_change.sql";
const check = (sql: string, changed: string[] = [FILE]) => checkMigrations([{ path: FILE, sql }], changed);
const LATER = "drop or change it in a later migration marked -- contract: <reason>, after no code reads the old shape";
const INDEX =
	"migrate.ts applies every migration in one transaction, so CREATE INDEX CONCURRENTLY cannot run there and a plain index locks the table's writes while it builds; build it in a separate migration marked -- contract: <reason>";

test("INV-migration-safety: an additive migration passes", () => {
	assert.deepEqual(
		check(`CREATE TABLE "pledge" (
	"id" uuid PRIMARY KEY,
	"amount" integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX "pledge_amount" ON "pledge" USING btree ("amount");--> statement-breakpoint
ALTER TABLE "pledge" ADD COLUMN "note" text NOT NULL;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "nickname" text;--> statement-breakpoint
ALTER TABLE "person" ADD COLUMN "tier" integer DEFAULT 1 NOT NULL;
ALTER TABLE person ADD CONSTRAINT person_tier CHECK (tier > 0) NOT VALID;
ALTER TABLE "person" ADD COLUMN "label" text NOT NULL DEFAULT 'none';
INSERT INTO audit_note (body) VALUES ('we will DROP TABLE nothing; RENAME nothing');`),
		[],
	);
});

const destructive: [string, string, string][] = [
	[
		"DROP TABLE",
		`DROP TABLE "pledge" CASCADE;`,
		`DROP TABLE "pledge" CASCADE: DROP TABLE removes a table the running code may still read; ${LATER}`,
	],
	[
		"DROP COLUMN",
		`ALTER TABLE "person" DROP COLUMN "nickname";`,
		`ALTER TABLE "person" DROP COLUMN "nickname": DROP COLUMN removes a column the running code may still read; ${LATER}`,
	],
	[
		"RENAME of a table",
		`alter table person rename to member;`,
		`alter table person rename to member: RENAME breaks the code that still uses the old name; ${LATER}`,
	],
	[
		"RENAME of a column",
		`ALTER TABLE "person" RENAME COLUMN "nickname" TO "alias";`,
		`ALTER TABLE "person" RENAME COLUMN "nickname" TO "alias": RENAME breaks the code that still uses the old name; ${LATER}`,
	],
	[
		"RENAME of a constraint",
		`ALTER TABLE "person" RENAME CONSTRAINT "a" TO "b";`,
		`ALTER TABLE "person" RENAME CONSTRAINT "a" TO "b": RENAME breaks the code that still uses the old name; ${LATER}`,
	],
	[
		"ALTER ... TYPE",
		`ALTER TABLE "person" ALTER COLUMN "tier" SET DATA TYPE bigint;`,
		`ALTER TABLE "person" ALTER COLUMN "tier" SET DATA TYPE bigint: ALTER ... TYPE rewrites a column the running code reads and writes; ${LATER}`,
	],
	[
		"SET NOT NULL without a default",
		`ALTER TABLE "person" ALTER COLUMN "nickname" SET NOT NULL;`,
		`ALTER TABLE "person" ALTER COLUMN "nickname" SET NOT NULL: SET NOT NULL without a default for person.nickname refuses the running code's NULL writes; set a default for the column in this migration, or ${LATER}`,
	],
	[
		"ADD COLUMN NOT NULL without DEFAULT on an existing table",
		`ALTER TABLE "person" ADD COLUMN "tier" integer NOT NULL;`,
		`ALTER TABLE "person" ADD COLUMN "tier" integer NOT NULL: ADD COLUMN ... NOT NULL without DEFAULT on the existing table person fails on its rows and refuses the running code's inserts; add a DEFAULT, or add it nullable and ${LATER}`,
	],
];

for (const [form, sql, problem] of destructive)
	test(`INV-migration-safety: ${form} without a marker fails, naming the file, statement and rule`, () => {
		assert.deepEqual(check(sql), [`${FILE}: ${problem}`]);
	});

test("INV-migration-safety: matching ignores case and SQL comments", () => {
	assert.deepEqual(
		check(`-- DROP TABLE person;
/* ALTER TABLE person RENAME TO member; */
create table pledge (id uuid);
alter table pledge add column amount int not null;`),
		[],
	);
	assert.deepEqual(check(`aLtEr TaBlE person /* note */ DrOp CoLuMn nickname; -- gone`), [
		`${FILE}: aLtEr TaBlE person DrOp CoLuMn nickname: DROP COLUMN removes a column the running code may still read; ${LATER}`,
	]);
});

test("INV-migration-safety: SET NOT NULL passes when the same migration sets that column's default", () => {
	assert.deepEqual(
		check(`ALTER TABLE "person" ALTER COLUMN "tier" SET DEFAULT 1;
ALTER TABLE "person" ALTER COLUMN "tier" SET NOT NULL;`),
		[],
	);
	assert.equal(
		check(`ALTER TABLE "person" ALTER COLUMN "other" SET DEFAULT 1;
ALTER TABLE "person" ALTER COLUMN "tier" SET NOT NULL;`).length,
		1,
	);
});

test("INV-migration-safety: an index on an existing table fails and says CONCURRENTLY cannot run in the runner", () => {
	assert.deepEqual(
		check(`CREATE INDEX "person_tier" ON "person" USING btree ("tier");
CREATE UNIQUE INDEX IF NOT EXISTS person_alias ON public.person (alias);`),
		[
			`${FILE}: CREATE INDEX "person_tier" ON "person" USING btree ("tier"): CREATE INDEX on the existing table person: ${INDEX}`,
			`${FILE}: CREATE UNIQUE INDEX IF NOT EXISTS person_alias ON public.person (alias): CREATE INDEX on the existing table person: ${INDEX}`,
		],
	);
});

test("INV-migration-safety: a marked contract migration with only schema and docs beside it passes", () => {
	assert.deepEqual(
		check(
			`-- contract: nothing reads person.nickname since the flag came off
ALTER TABLE "person" DROP COLUMN "nickname";
DROP TABLE "pledge";
CREATE INDEX "person_tier" ON "person" ("tier");`,
			[FILE, "packages/db/src/schema/tables.ts", "docs/schema/target.json", "tests/integration/db/baseline.test.mts"],
		),
		[],
	);
});

test("INV-migration-safety: a marker with an empty reason does not count", () => {
	assert.deepEqual(check(`-- contract:   \nDROP TABLE "pledge";`), [
		`${FILE}: the -- contract: marker has no reason; write why this contract step is safe now`,
		`${FILE}: DROP TABLE "pledge": DROP TABLE removes a table the running code may still read; ${LATER}`,
	]);
});

test("INV-migration-safety: a marked contract migration that also changes app code fails, listing the files", () => {
	assert.deepEqual(
		check(`-- contract: the old column is unread\nALTER TABLE "person" DROP COLUMN "nickname";`, [
			"apps/web/src/features/people/page.tsx",
			FILE,
			"packages/domain/src/people/core.ts",
		]),
		[
			`${FILE}: a contract migration lands alone, but this change also touches app code: apps/web/src/features/people/page.tsx, packages/domain/src/people/core.ts; move that code to an earlier change`,
		],
	);
});

function inRepo(body: (r: ReturnType<typeof repo>) => void) {
	const r = repo();
	try {
		body(r);
	} finally {
		rmSync(r.root, { recursive: true, force: true });
	}
}

function repo() {
	const root = mkdtempSync(join(tmpdir(), "migration-safety-"));
	const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
	const put = (path: string, text: string) => {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	};
	const commit = (message: string) => {
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", message);
	};
	git("init", "-q", "-b", "main");
	put("README.md", "fixture\n");
	commit("root");
	put("packages/db/migrations/0001_old.sql", `ALTER TABLE "person" DROP COLUMN "nickname";\n`);
	commit("base");
	put("README.md", "later\n");
	commit("later");
	git("update-ref", "refs/remotes/origin/main", "HEAD");
	const run = (...args: string[]) => {
		const result = spawnSync(process.execPath, [TOOL, ...args], { cwd: root, encoding: "utf8" });
		return { status: result.status, stdout: result.stdout, stderr: result.stderr };
	};
	return { root, git, put, commit, run };
}

test("INV-migration-safety: the command reads only a branch's added migrations against the merge base", () =>
	inRepo((r) => {
		assert.equal(r.run().status, 0, "a destructive migration already on the base is never scanned");
		r.git("switch", "-q", "-c", "feature");
		r.put("packages/db/migrations/20261118000000_add.sql", `ALTER TABLE "person" ADD COLUMN "nickname" text;\n`);
		r.commit("additive");
		assert.equal(r.run().status, 0);
		r.put("packages/db/migrations/20261118000001_drop.sql", `DROP TABLE "pledge";\n`);
		const uncommitted = r.run();
		assert.equal(uncommitted.status, 1);
		assert.match(
			uncommitted.stderr,
			/^packages\/db\/migrations\/20261118000001_drop\.sql: DROP TABLE "pledge": DROP TABLE/,
		);
		assert.match(uncommitted.stdout, /2 added migration\(s\) against the merge base [0-9a-f]{12} with origin\/main/);
	}));

test("INV-migration-safety: on main, the command reads the head commit's added migrations against its first parent", () =>
	inRepo((r) => {
		r.put("packages/db/migrations/20261118000000_drop.sql", `DROP TABLE "pledge";\n`);
		r.put("apps/web/page.tsx", "export {};\n");
		r.commit("direct push");
		r.git("update-ref", "refs/remotes/origin/main", "HEAD");
		r.git("checkout", "-q", "--detach", "HEAD");
		const pushed = r.run();
		assert.equal(pushed.status, 1);
		assert.match(pushed.stdout, /1 added migration\(s\) against the head commit's first parent/);
		r.put("packages/db/migrations/20261118000001_more.sql", "SELECT 1;\n");
		r.put(
			"packages/db/migrations/20261118000000_drop.sql",
			`-- contract: unread since the flag came off\nDROP TABLE "pledge";\n`,
		);
		assert.equal(r.run().status, 1, "the committed head is read, not the working tree");
	}));
