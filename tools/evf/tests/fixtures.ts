import { evfDataDir } from "../lib.ts";
import { setLoadedCode } from "../merge.ts";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn, spawnSync } from "node:child_process";
export const source = resolve(import.meta.dirname, "../../..");
/** Runs a repo TypeScript file with tsx, as the QA seed runs, with `env` over a clean NODE_ENV and DATABASE_URL. */
export function tsxRun(args: string[], env: Record<string, string | undefined>) {
	const clean: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: undefined, DATABASE_URL: undefined, ...env };
	for (const k of Object.keys(clean)) if (clean[k] === undefined) delete clean[k];
	const tsx = join(source, "packages/domain/node_modules/.bin/tsx");
	return spawnSync(tsx, ["--conditions=react-server", ...args], { cwd: source, encoding: "utf8", env: clean });
}
export const runSeed = (env: Record<string, string | undefined>) => tsxRun(["tools/evf/qa-seed.ts"], env);
/** The work store migration files in number order. A test that migrates a store reads them, so a new one edits no test. */
export const STORE_MIGRATIONS = readdirSync(join(source, "tools/evf/db/migrations"))
	.filter((f) => /^\d{3}-.*\.sql$/.test(f))
	.sort();
/** The highest work store migration number. */
export const STORE_LATEST = Number(STORE_MIGRATIONS.at(-1)!.slice(0, 3));
/** The migration files numbered `n` or higher: what `migrate` applies to a store that has every migration below `n`. */
export const migrationsFrom = (n: number) => STORE_MIGRATIONS.filter((f) => Number(f.slice(0, 3)) >= n);
/**
 * Source for a fake Herdr's `agent start` branch: it records the `session_start` event that the Claude session-start
 * hook writes, for the run whose id ends the agent name. In the fake's state, `noSession` skips it (a Claude that never
 * reaches its hook) and `sessionDelayMs` records it that many milliseconds later from a detached process.
 */
export const sessionStartJs = (dbPath: string, stateVar = "st") => {
	const insert =
		`(name)=>{const m=/-(\\d+)$/.exec(name);if(!m)return;const {DatabaseSync}=require("node:sqlite");` +
		`const d=new DatabaseSync(${JSON.stringify(dbPath)});d.exec("PRAGMA busy_timeout = 5000");` +
		`const r=d.prepare("SELECT task_id FROM runs WHERE id = ?").get(Number(m[1]));` +
		`if(r)d.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, 'session_start', '{}')").run(r.task_id,Number(m[1]),new Date().toISOString());d.close()}`;
	return (
		`if(a[0]==="agent"&&a[1]==="start"&&!(${stateVar}&&(${stateVar}.noSession||${stateVar}.startFails||${stateVar}.failStarts>0||${stateVar}.busyStarts>0))){` +
		`if(${stateVar}&&${stateVar}.sessionDelayMs)require("node:child_process").spawn(process.execPath,["-e","setTimeout(()=>("+${JSON.stringify(insert)}+")(process.argv[1]),"+${stateVar}.sessionDelayMs+")",a[2]],{detached:true,stdio:"ignore"}).unref();` +
		`else (${insert})(a[2])}\n`
	);
};

// Fixture repos hold no evf code of their own. Unless a test claims otherwise, the process runs the base code.
setLoadedCode((base) => ({ checkout: "fixture", ...base, dirty: false }));
// The evf subprocesses a test starts make the same claim through a preload (current-code.ts).
process.env.NODE_OPTIONS =
	`${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(import.meta.dirname, "current-code.ts")).href}`.trim();

// A drive that a test starts through main.ts starts no real sampler. The sampler tests clear this on purpose.
process.env.EVF_NO_SAMPLER = "1";

/** The environment of a real evf process that a test starts: it carries no seat identity. */
export const noSeatEnv = () => ({
	...process.env,
	EVF_RUN: "",
	EVF_WORKTREE: "",
	EVF_SESSION: "",
	EVF_ROLE: "",
	EVF_STAGE: "",
});

/** Runs real evf through main.ts in `cwd`. */
export const cli = (cwd: string, env: Record<string, string>, ...args: string[]) =>
	spawnSync(process.execPath, [join(source, "tools/evf/main.ts"), ...args], {
		cwd,
		encoding: "utf8",
		env: { ...noSeatEnv(), ...env },
	});

/** A real process that holds a task's pid file. Named `main.ts` with the args `drive <id>`, its command reads as a drive. */
export async function pidFileHolder(root: string, slug: string, name: string, ...args: string[]) {
	const script = join(root, name);
	writeFileSync(script, "setInterval(() => {}, 1000);\n");
	const child = spawn(process.execPath, [script, ...args], { stdio: "ignore" });
	await new Promise((resolve) => child.once("spawn", resolve));
	mkdirSync(join(evfDataDir(root), "drive"), { recursive: true });
	writeFileSync(join(evfDataDir(root), "drive", `${slug}.pid`), `${child.pid}\n`);
	const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_, signal) => resolve(signal)));
	return { child, exited };
}

/**
 * A clock that a test moves. `sleep` records the wait, advances the time and returns at once. It starts at the current
 * real time, because a wait also compares it with timestamps in the store. `onSleep` runs after each sleep with the
 * elapsed fake time, so a close that a real timer used to do becomes a step at a fixed time.
 */
export function fakeClock(onSleep: (elapsed: number) => void = () => {}) {
	const start = Date.now(),
		sleeps: number[] = [];
	let time = start;
	return {
		now: () => time,
		sleep(ms: number) {
			sleeps.push(ms);
			time += ms;
			onSleep(time - start);
		},
		elapsed: () => time - start,
		sleeps,
	};
}

export function fixture() {
	// Git starts detached auto-maintenance after commits and pushes. It would write into the fixture while
	// close() removes it, so every git process this test starts runs with automatic background work off.
	// A local push clears this environment for the receiving side, so bare receivers come from bare() below.
	const n = Number(process.env.GIT_CONFIG_COUNT ?? 0),
		noBackground = [
			["maintenance.auto", "false"],
			["gc.auto", "0"],
			["receive.autogc", "false"],
		];
	const scoped: Record<string, string> = {
		GIT_CONFIG_COUNT: String(n + noBackground.length),
		...Object.fromEntries(
			noBackground.flatMap(([k, v], i) => [
				[`GIT_CONFIG_KEY_${n + i}`, k],
				[`GIT_CONFIG_VALUE_${n + i}`, v],
			]),
		),
	};
	const saved = Object.fromEntries(
		["PATH", "EVF_FAKE_GH_STATE", "EVF_MONITOR", ...Object.keys(scoped)].map((k) => [k, process.env[k]]),
	);
	Object.assign(process.env, scoped);
	process.env.EVF_MONITOR = "disposable-test-runner";
	const root = mkdtempSync(join(tmpdir(), "evf-regression-"));
	cpSync(join(source, "docs"), join(root, "docs"), { recursive: true });
	cpSync(join(source, "design/handoff"), join(root, "design/handoff"), { recursive: true });
	cpSync(join(source, "AGENTS.md"), join(root, "AGENTS.md"));
	cpSync(join(source, "README.md"), join(root, "README.md"));
	cpSync(join(source, ".agents/skills/everyfield-pr"), join(root, ".agents/skills/everyfield-pr"), { recursive: true });
	cpSync(join(source, "tools/evf/templates"), join(root, "tools/evf/templates"), { recursive: true });
	cpSync(join(source, ".claude/agents"), join(root, ".claude/agents"), { recursive: true });
	const dag = JSON.parse(readFileSync(join(root, "docs/plan/dag.json"), "utf8"));
	const progressPath = join(root, "docs/build-progress.json");
	const progress = {
		schema_version: 1,
		project_id: "everyfield-v3",
		revision: 0,
		updated_at: null,
		packages: Object.fromEntries(
			dag.packages.map((p) => [
				p.id,
				{
					status: "not_started",
					revision: 0,
					updated_at: null,
					evidence: [],
					notes: "Disposable active-package fixture.",
				},
			]),
		),
	};
	writeFileSync(progressPath, JSON.stringify(progress));
	const cfg = JSON.parse(readFileSync(join(source, "evf.config.json"), "utf8"));
	cfg.stack = null; // Tests that need a stack declare their own; never run the live stack command.
	cfg.machineLoad = { maxPerCore: 1_000_000, maxWaitMinutes: 0 }; // Tooling tests never wait for this machine's load.
	cfg.checks = [
		{ name: "fixture-check", run: [process.execPath, "-e", 'process.stdout.write("checked disposable fixture")'] },
		...["format", "package-unit-tests"].map((name) => ({
			name,
			run: [process.execPath, "-e", `process.stdout.write("${name} ran")`],
		})),
	];
	cfg.feedback = {
		...cfg.feedback,
		repo: "test/feedback",
		botAuthor: "app-bot",
		botAuthorId: 101,
		triageActorIds: [202],
		publicAreas: ["Documents"],
		publicTemplates: [
			{
				category: "bug",
				title: "Bug report — {area}",
				body: "A product bug report was submitted for {area}. Private details are retained for authorized triage. Reference: {marker}.",
			},
		],
	};
	writeFileSync(join(root, "evf.config.json"), JSON.stringify(cfg, null, 2));
	const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
	git("init", "-b", "main");
	git("config", "user.name", "Fixture");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "core.hooksPath", "/dev/null");
	const bins = join(root, "fake-bin");
	mkdirSync(bins);
	const statePath = join(root, "gh-state.json");
	const state = {
		repo: { id: 301, node_id: "R_feedback", full_name: "test/feedback" },
		user: { id: 202 },
		issues: Array.from({ length: 5 }, (_, i) => ({
			number: i + 1,
			node_id: `I_${i + 1}`,
			title: "Bug report — Documents",
			body: "A product bug report was submitted for Documents. Private details are retained for authorized triage. Reference: 11111111-1111-4111-8111-111111111111.",
			html_url: `https://github.com/test/feedback/issues/${i + 1}`,
			state: "open",
			created_at: "2026-10-01T00:00:00Z",
			user: { id: 101, login: "app-bot" },
			labels: [{ name: "needs-triage" }],
		})),
		comments: {} as Record<string, unknown[]>,
		calls: [] as unknown[],
	};
	writeFileSync(statePath, JSON.stringify(state));
	const fake = join(bins, "gh");
	writeFileSync(
		fake,
		`#!${process.execPath}\n` +
			String.raw`
const fs=require('node:fs');const a=process.argv.slice(2),p=process.env.EVF_FAKE_GH_STATE;
if(!p)throw Error('No disposable fake-provider state');
const s=JSON.parse(fs.readFileSync(p,'utf8'));const opt=k=>a[a.indexOf(k)+1];
let body=a.includes('--body-file')?fs.readFileSync(opt('--body-file'),'utf8'):opt('--body');
s.calls.push({args:a,...(body?{body}: {})});
let result;
if(a[0]==='api') {
 const path=a.find(x=>x==='user'||x.startsWith('repos/')||x.startsWith('gists/'));
 if(s.api&&path in s.api)result=s.api[path];
 else if(path==='user')result=s.user;
 else if(path==='gists/a1b2c3')result='fixture-owner';
 else if(path==='repos/test/feedback')result=s.repo;
 else if(path==='repos/test/private')result=s.internalRepo||{id:401,node_id:'R_private'};
 else if(/issues\?/.test(path))result=[s.issues.filter(i=>path.includes('state=all')||i.state==='open')];
 else if(/issues\/\d+\/comments$/.test(path))result=[s.comments[path.split('/')[4]]||[]];
 else if(/issues\/\d+$/.test(path))result=s.issues.find(i=>i.number===Number(path.split('/').pop()));
 else if(/pulls\/\d+\/reviews/.test(path))result=[s.reviews||[]];
 else if(/commits\/.*\/status$/.test(path))result=s.commitStatus||{statuses:[]};
 else if(/statuses\//.test(path)&&a.includes('POST'))result={};
 else if(/rules\/branches\/main$/.test(path))result=s.rules??[];
 else if(/branches\/main\/protection/.test(path))result=s.protection||{required_status_checks:{strict:true,contexts:['evf/verify']},enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:1,dismiss_stale_reviews:true}};
 process.exitCode=s.apiExit?.[path];
}
else if(a[0]==='repo'&&a[1]==='view')result=a.includes('-q')||a.includes('--jq')?'test/private':{nameWithOwner:'test/private',isPrivate:true};
else if(a[0]==='pr'&&a[1]==='view'){if(s.prViewBodies?.length&&s.pr)s.pr.body=s.prViewBodies.shift();result=a.includes('mergeCommit')?s.mergeCommit:opt('--json')==='body'&&a.includes('--jq')?s.pr.body:s.pr||{number:77,url:'https://github.com/test/private/pull/77',state:'OPEN'};}
else if(a[0]==='pr'&&a[1]==='list')result=s.openPrs??[];
else if(a[0]==='run'&&a[1]==='list')result=s.mainRuns??[{conclusion:'success',headSha:'f'.repeat(40),url:'https://github.com/test/private/actions/runs/1'}];
else if(a[0]==='pr'&&a[1]==='checks'){result=s.checksQueue?.length?s.checksQueue.shift():s.requiredChecks??[];if(s.checksError){fs.writeFileSync(p,JSON.stringify(s));process.stdout.write(JSON.stringify(result));process.exit(s.checksError);}}
else if(a[0]==='pr'&&a[1]==='update-branch'){
 const cp=require('node:child_process'),os=require('node:os'),path=require('node:path');
 const g=(...x)=>cp.execFileSync('git',x,{encoding:'utf8'}).trim();
 const branch=g('-C',process.cwd(),'branch','--show-current'),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'evf-update-branch-'));
 g('clone','-q','-b',branch,g('-C',process.cwd(),'remote','get-url','origin'),tmp);
 g('-C',tmp,'-c','user.name=GitHub','-c','user.email=noreply@github.invalid','merge','-q','--no-ff','--no-edit','origin/main');
 g('-C',tmp,'push','-q','origin',branch);s.pr.headRefOid=g('-C',tmp,'rev-parse','HEAD');fs.rmSync(tmp,{recursive:true,force:true});result='';
}
else if(a[0]==='pr'&&a[1]==='edit'){if(body&&s.pr)s.pr.body=body;result='';}
else if(a[0]==='pr'&&a[1]==='create')result='https://github.com/test/private/pull/78';
else if(a[0]==='gist'&&a[1]==='create')result='https://gist.github.com/fixture-owner/a1b2c3';
else if(a[0]==='pr'&&a[1]==='comment'){result='https://github.com/test/private/pull/'+a[2]+'#comment';(s.comments[a[2]]??=[]).push({body,html_url:result});}
else if(a[0]==='pr'&&a[1]==='merge'){
 if(!s.allowMerge){fs.writeFileSync(p,JSON.stringify(s));process.stderr.write('fixture merge barrier');process.exit(1);}
 const cp=require('node:child_process'),cwd=fs.realpathSync(process.cwd()+'/../..');
 cp.execFileSync('git',['-C',cwd,'merge','--no-ff','-m','Fixture reviewed merge',s.mergeBranch]);
 s.mergeCommit=cp.execFileSync('git',['-C',cwd,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
 cp.execFileSync('git',['-C',cwd,'push','-q','origin','main']);result='';
}
else if(a[0]==='issue') {
 const n=Number(a[2]);
 if(a[1]==='comment'){(s.comments[n]??=[]).push({body,user:s.user});result='https://github.com/test/feedback/issues/'+n+'#comment';}
 if(a[1]==='edit'){const i=s.issues.find(i=>i.number===n);if(a.includes('--add-label'))i.labels.push(...opt('--add-label').split(',').map(name=>({name})));if(a.includes('--remove-label'))i.labels=i.labels.filter(l=>!opt('--remove-label').split(',').includes(l.name));result='';}
 if(a[1]==='close'){if(s.failClose){fs.writeFileSync(p,JSON.stringify(s));process.stderr.write('fixture close failure');process.exit(1);}s.issues.find(i=>i.number===n).state='closed';result='';}
 if(a[1]==='list')result=s.internalIssues||[];
 if(a[1]==='create'){if(s.failCreate){fs.writeFileSync(p,JSON.stringify(s));process.exit(1);}result='https://github.com/test/private/issues/'+(800+s.calls.filter(c=>c.args[0]==='issue'&&c.args[1]==='create').length);}
}
else if(a[0]==='label')result='';
if(result===undefined){fs.writeFileSync(p,JSON.stringify(s));throw Error('Unexpected external call: '+a.join(' '));}
fs.writeFileSync(p,JSON.stringify(s));process.stdout.write(typeof result==='string'?result:JSON.stringify(result));
`,
	);
	chmodSync(fake, 0o755);
	writeFileSync(join(root, ".gitignore"), "fake-bin/\ngh-state.json\n");
	git(
		"add",
		"docs",
		"design/handoff",
		"AGENTS.md",
		"README.md",
		"evf.config.json",
		".gitignore",
		".agents/skills/everyfield-pr",
		"tools/evf/templates",
		".claude/agents",
	);
	git("commit", "-qm", "Disposable context");
	process.env.PATH = bins + ":" + saved.PATH;
	process.env.EVF_FAKE_GH_STATE = statePath;
	return {
		root,
		cfg,
		git,
		getState: () => JSON.parse(readFileSync(statePath, "utf8")),
		setState: (s: unknown) => writeFileSync(statePath, JSON.stringify(s)),
		authorize: (wp = "WP-001") => {
			const progress = JSON.parse(readFileSync(progressPath, "utf8"));
			const prerequisites = new Set<string>();
			const visit = (id: string) => {
				const pkg = dag.packages.find((p) => p.id === id)!;
				for (const dep of [...pkg.depends_on, ...(pkg.ui_depends_on ?? [])])
					if (!prerequisites.has(dep)) {
						prerequisites.add(dep);
						visit(dep);
					}
			};
			visit(wp);
			for (const id of prerequisites) progress.packages[id].status = "done";
			writeFileSync(progressPath, JSON.stringify(progress));
			const p = join(root, "docs/plan/release-gates.json");
			const d = JSON.parse(readFileSync(p, "utf8"));
			for (const g of d.gates)
				g.status =
					g.id === "G-AUTH" ? "authorized" : g.id === "G-WORKFLOW" ? "reconciled-independent-review" : "approved";
			writeFileSync(p, JSON.stringify(d));
			writeFileSync(join(root, "evf.config.json"), JSON.stringify(cfg));
		},
		task: (slug = "wp-001") => {
			mkdirSync(join(root, ".worktrees"), { recursive: true });
			git("worktree", "add", "-b", "task/" + slug, join(root, ".worktrees", slug), "main");
			return join(root, ".worktrees", slug);
		},
		bare: (path: string) => {
			execFileSync("git", ["init", "-q", "--bare", path]);
			for (const [k, v] of noBackground) execFileSync("git", ["--git-dir", path, "config", k, v]);
			return path;
		},
		commit: () => {
			git("add", "docs", "evf.config.json");
			git("commit", "-qm", "Reviewed fixture policy");
		},
		close: () => {
			for (const [k, v] of Object.entries(saved))
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			// A fake tool that a stopped drive left running can still write here for a moment.
			rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		},
	};
}

/** A string that must never reach the store or a report: fixture transcripts carry it in message text and tool results. */
export const MARKER = "SECRET-MARKER-9f3c";

type Usage = {
	input?: number;
	output?: number;
	read?: number;
	write?: number;
	write1h?: number;
};
/** One assistant transcript line, as Claude Code writes it: usage under message.usage, text in message.content. */
export function assistantLine(id: string, model: string, u: Usage, content = `text ${MARKER}`) {
	return JSON.stringify({
		type: "assistant",
		message: {
			id,
			model,
			role: "assistant",
			content: [{ type: "text", text: content }],
			usage: {
				input_tokens: u.input ?? 0,
				output_tokens: u.output ?? 0,
				cache_read_input_tokens: u.read ?? 0,
				cache_creation_input_tokens: u.write ?? 0,
				...(u.write1h === undefined
					? {}
					: {
							cache_creation: {
								ephemeral_5m_input_tokens: (u.write ?? 0) - u.write1h,
								ephemeral_1h_input_tokens: u.write1h,
							},
						}),
			},
		},
	});
}
export const toolResultLine = () =>
	JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: MARKER }] } });

/** Write a session transcript (and optional subagent transcripts) under `<configDir>/projects/<slug>/`. */
export function writeTranscript(configDir: string, session: string, lines: string[], subagents: string[][] = []) {
	const dir = join(configDir, "projects", "-fixture-cwd");
	mkdirSync(join(dir, session, "subagents"), { recursive: true });
	writeFileSync(join(dir, `${session}.jsonl`), lines.join("\n") + "\n");
	subagents.forEach((sub, i) =>
		writeFileSync(join(dir, session, "subagents", `agent-${i}.jsonl`), sub.join("\n") + "\n"),
	);
}

/** Timed transcript lines for the time split (OPS-134). `ms` is the entry's time; each line carries MARKER as its text. */
const at = (ms: number) => new Date(ms).toISOString();
export const promptLine = (ms: number, meta = false) =>
	JSON.stringify({
		type: "user",
		timestamp: at(ms),
		...(meta ? { isMeta: true } : {}),
		message: { role: "user", content: `prompt ${MARKER}` },
	});
export const toolCallLine = (ms: number, id: string, name: string, input: Record<string, unknown> = {}) =>
	JSON.stringify({
		type: "assistant",
		timestamp: at(ms),
		message: {
			id: `msg-${id}`,
			model: "claude-opus-5-5",
			stop_reason: "tool_use",
			content: [{ type: "tool_use", id, name, input }],
		},
	});
export const toolDoneLine = (ms: number, id: string) =>
	JSON.stringify({
		type: "user",
		timestamp: at(ms),
		message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: MARKER }] },
	});
export const endTurnLine = (ms: number) =>
	JSON.stringify({
		type: "assistant",
		timestamp: at(ms),
		message: {
			id: `msg-end-${ms}`,
			model: "claude-opus-5-5",
			stop_reason: "end_turn",
			content: [{ type: "text", text: MARKER }],
		},
	});
