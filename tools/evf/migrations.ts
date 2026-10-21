import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { baseRef, fail, git, gitOk, hasRemote, loadConfig, requireWorktree, run, type TaskRef } from "./lib.ts";

/** Drizzle migrations: NNNN_name.sql, meta/NNNN_snapshot.json chained by id/prevId, and meta/_journal.json. */
const DIR = "packages/db/migrations";
const SQL = /^(\d{4})_([a-z0-9_]+)\.sql$/;
type Entry = { idx: number; when: number; tag: string; [key: string]: unknown };
type Journal = { entries: Entry[]; [key: string]: unknown };
type Snapshot = { id: string; prevId: string; [key: string]: unknown };

const pad = (n: number) => String(n).padStart(4, "0");
const numberOf = (name: string) => Number(SQL.exec(name)![1]);
const show = (repo: string, rev: string, path: string) => {
	const r = run("git", ["show", `${rev}:${path}`], { cwd: repo });
	return r.code === 0 ? r.stdout : undefined;
};

/** SQL migrations in the checkout that main does not have, in their current order. */
function branchSql(repo: string, main: string): { main: string[]; added: string[] } {
	if (!existsSync(join(repo, DIR)) || !gitOk(repo, "cat-file", "-e", `${main}:${DIR}`)) return { main: [], added: [] };
	const onMain = git(repo, "ls-tree", "--name-only", `${main}:${DIR}`)
		.split("\n")
		.filter((name) => SQL.test(name));
	const added = readdirSync(join(repo, DIR))
		.filter((name) => SQL.test(name) && !onMain.includes(name))
		.sort();
	return { main: onMain, added };
}

/** Branch migrations whose numbers main already uses or has passed. */
export function migrationCollisions(repo: string, main: string): string[] {
	const { main: onMain, added } = branchSql(repo, main);
	const last = Math.max(0, ...onMain.map(numberOf));
	return added.filter((name) => numberOf(name) <= last);
}

export function requireFreeMigrationNumbers(repo: string, main: string, task: TaskRef): void {
	const taken = migrationCollisions(repo, main);
	if (taken.length)
		fail(
			`New migrations ${taken.join(", ")} reuse numbers main already has. Run evf migrations renumber ${task.id}, commit, then verify again.`,
		);
}

/** A branch file as the branch's own commits wrote it: merge resolutions and main's copy never count. */
function branchVersion(repo: string, main: string, path: string): string | undefined {
	const commit = git(repo, "log", "-1", "--no-merges", "--format=%H", `${main}..HEAD`, "--", path);
	return commit ? show(repo, commit, path) : undefined;
}

/** Main's value for each key, with the branch's change applied where only the branch changed it. */
function threeWay(base: unknown, ours: unknown, theirs: unknown, at: string): unknown {
	if (isDeepStrictEqual(theirs, base)) return ours;
	if (isDeepStrictEqual(ours, base) || isDeepStrictEqual(ours, theirs)) return theirs;
	const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
	if (!isMap(base) || !isMap(ours) || !isMap(theirs))
		fail(
			`Main and this branch both change ${at}. Remove the branch migrations and generate them again on current main.`,
		);
	const merged: Record<string, unknown> = {};
	for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
		const value = threeWay(base[key], ours[key], theirs[key], `${at}.${key}`);
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

/**
 * Move the branch's new migrations after main's last number and rebuild the journal and snapshot chain. Main's
 * files keep main's bytes; each branch snapshot becomes main's latest schema plus the branch's own changes.
 * Runs on a clean checkout that includes main, or inside a merge of main whose conflicts are all migration files.
 */
export function renumberMigrations(repo: string, main: string): string[] {
	const merging = gitOk(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD");
	const conflicts = git(repo, "diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
	if (!merging && git(repo, "status", "--porcelain", "--untracked-files=all") !== "")
		fail("Commit or remove local changes first. evf migrations renumber runs on a clean checkout or a merge of main.");
	if (conflicts.some((path) => !path.startsWith(`${DIR}/`)))
		fail("Resolve the conflicts outside the migrations folder first.");
	if (!gitOk(repo, "merge-base", "--is-ancestor", main, merging ? "MERGE_HEAD" : "HEAD"))
		fail(`Include current main first: git merge ${main}.`);
	const { main: onMain, added } = branchSql(repo, main);
	if (!added.length) return [];
	const meta = `${DIR}/meta`;
	const mainJournal = JSON.parse(show(repo, main, `${meta}/_journal.json`)!) as Journal;
	const mainMeta = git(repo, "ls-tree", "--name-only", `${main}:${meta}`).split("\n");
	const mainSnapshots = mainMeta
		.filter((name) => /^\d{4}_snapshot\.json$/.test(name))
		.sort()
		.map((name) => JSON.parse(show(repo, main, `${meta}/${name}`)!) as Snapshot);
	const last = Math.max(0, ...onMain.map(numberOf)),
		mainLast = mainSnapshots.at(-1);
	const branchJournal = JSON.parse(branchVersion(repo, main, `${meta}/_journal.json`) ?? '{"entries":[]}') as Journal;
	const moves = added.map((name, i) => {
		const tag = name.slice(0, -4),
			snapshot = branchVersion(repo, main, `${meta}/${pad(numberOf(name))}_snapshot.json`),
			entry = branchJournal.entries.find((e) => e.tag === tag);
		if (!snapshot || !entry) fail(`Cannot find the journal entry and snapshot this branch committed for ${name}.`);
		return { name, tag, entry, snapshot: JSON.parse(snapshot) as Snapshot, to: last + 1 + i };
	});
	const base = mainSnapshots.find((s) => s.id === moves[0].snapshot.prevId);
	if (!base || !mainLast) fail(`The branch's first migration ${moves[0].name} does not follow a snapshot on main.`);

	// Compute every file before writing any, so a refusal leaves the checkout as it was.
	const schema = ({ id: _id, prevId: _prev, ...rest }: Snapshot) => rest;
	const entries = [...mainJournal.entries];
	const writes = moves.map((move, i) => {
		const target = `${pad(move.to)}_${SQL.exec(move.name)![2]}`;
		const merged = threeWay(schema(base), schema(mainLast), schema(move.snapshot), "snapshot") as object;
		const prevId = i === 0 ? mainLast.id : moves[i - 1].snapshot.id;
		entries.push({
			...move.entry,
			idx: move.to,
			tag: target,
			when: Math.max(move.entry.when, entries.at(-1)!.when + 1),
		});
		return { move, target, snapshot: { id: move.snapshot.id, prevId, ...merged } };
	});
	// Main's meta files get main's bytes back; the branch's snapshots and journal entries follow main's.
	git(repo, "checkout", main, "--", meta);
	for (const name of readdirSync(join(repo, meta))) if (!mainMeta.includes(name)) unlinkSync(join(repo, meta, name));
	// Read every source before writing any target: 0002_x can move onto the name 0003_x still holds.
	const sources = writes.map(({ move }) => readFileSync(join(repo, DIR, move.name)));
	for (const { move } of writes) unlinkSync(join(repo, DIR, move.name));
	for (const [i, { move, target, snapshot }] of writes.entries()) {
		writeFileSync(join(repo, DIR, `${target}.sql`), sources[i]);
		writeFileSync(join(repo, meta, `${pad(move.to)}_snapshot.json`), JSON.stringify(snapshot, null, 2));
	}
	writeFileSync(join(repo, meta, "_journal.json"), JSON.stringify({ ...mainJournal, entries }, null, 2));
	git(repo, "add", "-A", DIR);
	return writes.map(({ move, target }) => `${move.name} -> ${target}.sql`);
}

export function migrationsRenumber(root: string, task: TaskRef): number {
	const cfg = loadConfig(root),
		wt = requireWorktree(root, cfg, task);
	if (hasRemote(root, cfg)) git(root, "fetch", "--quiet", cfg.remote, cfg.baseBranch);
	const moves = renumberMigrations(wt, baseRef(root, cfg));
	if (!moves.length) console.log("migrations: this branch adds no migrations.");
	else
		console.log(
			`migrations: ${moves.join(", ")}. Staged the files and the rebuilt journal and snapshots. Regenerate the schema catalog if it names migrations, commit, then run evf verify ${task.id}.`,
		);
	return 0;
}
