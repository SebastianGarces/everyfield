import { spawnSync } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import {
	cpSync,
	existsSync,
	globSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";

const TLA_TOOLS = {
	version: "1.7.4",
	url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
	sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
};
const JAVA_IMAGE = "eclipse-temurin@sha256:18bb4a91a3dea3f03ee31d3755af34dfb40f904fc77ab56cdc2f092e32fff9c2";
const TLC_TIMEOUT_MS = 10 * 60 * 1000;

class FormalError extends Error {
	name = "FormalError";
}

const cacheDir = (env = process.env) =>
	env.EVERYFIELD_FORMAL_CACHE ?? join(homedir(), ".cache", "everyfield", "formal");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

async function tlaTools(dir = cacheDir()): Promise<string> {
	const jar = join(dir, `tla2tools-${TLA_TOOLS.version}.jar`);
	if (!existsSync(jar)) {
		mkdirSync(dir, { recursive: true });
		const response = await fetch(TLA_TOOLS.url);
		if (!response.ok) throw new FormalError(`Could not download ${TLA_TOOLS.url}: HTTP ${response.status}`);
		writeFileSync(jar + ".part", Buffer.from(await response.arrayBuffer()));
		renameSync(jar + ".part", jar);
	}
	const actual = sha256(jar);
	if (actual !== TLA_TOOLS.sha256) {
		rmSync(jar, { force: true });
		throw new FormalError(`${jar} has sha256 ${actual}, not the pinned ${TLA_TOOLS.sha256}. It was deleted.`);
	}
	return jar;
}

type Runner = { kind: "java" } | { kind: "docker"; env: Record<string, string> };

function runner(): Runner {
	const java = spawnSync("java", ["-version"], { encoding: "utf8" });
	const version = /version "(\d+)/.exec(`${java.stderr ?? ""}${java.stdout ?? ""}`);
	if (java.status === 0 && version && Number(version[1]) >= 11) return { kind: "java" };
	const config = join(cacheDir(), "docker-config");
	mkdirSync(config, { recursive: true });
	writeFileSync(join(config, "config.json"), "{}\n");
	const hosts = process.env.DOCKER_HOST
		? [process.env.DOCKER_HOST]
		: (
				spawnSync("docker", ["context", "ls", "--format", "{{.Current}} {{.DockerEndpoint}}"], { encoding: "utf8" })
					.stdout ?? ""
			)
				.split("\n")
				.filter(Boolean)
				.sort((a, b) => (a.startsWith("true") ? -1 : b.startsWith("true") ? 1 : 0))
				.map((line) => line.split(" ")[1]!);
	for (const host of hosts) {
		const env = { DOCKER_HOST: host, DOCKER_CONFIG: config };
		if (spawnSync("docker", ["info"], { env: { ...process.env, ...env }, stdio: "ignore" }).status === 0)
			return { kind: "docker", env };
	}
	throw new FormalError("TLC needs Java 11 or newer, or a running Docker. Neither answered.");
}

type Simulate = { traces: number; depth: number; seed: number };

const STATE_MARK = '<< "evf-state",';

function simulation(dir: string, spec: string, config: string) {
	const tla = globSync("*.tla", { cwd: dir })
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.join("\n");
	const variables = (/^VARIABLES?\s+([\s\S]*?)\n\s*\n/m.exec(tla)?.[1] ?? "")
		.replace(/\\\*.*$/gm, "")
		.split(",")
		.map((v) => v.trim())
		.filter(Boolean);
	if (!variables.length) throw new FormalError(`${dir} declares no VARIABLES for its simulation to print.`);
	const name = `Sim${spec.replace(/\.tla$/, "")}`;
	const module = `---- MODULE ${name} ----
EXTENDS ${spec.replace(/\.tla$/, "")}, TLC
EvfPairs(f) == {<<k, f[k]>> : k \\in DOMAIN f}
EvfTraceState == PrintT(<<"evf-state", TLCGet("level"), <<${variables.map((v) => `EvfPairs(${v})`).join(", ")}>>>>)
====
`;
	let skip = false;
	const kept = config.split("\n").filter((line) => {
		if (/^[A-Z]/.test(line)) skip = /^(?:INVARIANTS?|PROPERTY|PROPERTIES)\b/.test(line);
		return !skip;
	});
	return { name, module, config: `${kept.join("\n")}\nINVARIANT EvfTraceState\n`, variables };
}

function tlc(dir: string, jar: string, how: Runner, simulate?: Simulate) {
	const configs = globSync("MC*.cfg", { cwd: dir });
	if (configs.length !== 1) throw new FormalError(`${dir} needs exactly one MC*.cfg; it has ${configs.length}.`);
	const config = configs[0]!,
		spec = config.replace(/\.cfg$/, ".tla");
	if (!existsSync(join(dir, spec))) throw new FormalError(`${dir}/${config} has no ${spec} beside it.`);
	const work = mkdtempSync(join(cacheDir(), "run-"));
	try {
		for (const file of globSync("*.{tla,cfg}", { cwd: dir })) cpSync(join(dir, file), join(work, file));
		const sim = simulate && simulation(dir, spec, readFileSync(join(dir, config), "utf8"));
		if (sim) {
			writeFileSync(join(work, `${sim.name}.tla`), sim.module);
			writeFileSync(join(work, `${sim.name}.cfg`), sim.config);
		}
		const mode = simulate
			? [
					"-simulate",
					`num=${simulate.traces}`,
					"-depth",
					`${simulate.depth}`,
					"-seed",
					`${simulate.seed}`,
					"-workers",
					"1",
				]
			: ["-workers", "auto"];
		const args = [
			"-XX:+UseParallelGC",
			"-jar",
			jar,
			...mode,
			"-deadlock",
			"-cleanup",
			"-config",
			sim ? `${sim.name}.cfg` : config,
			sim ? `${sim.name}.tla` : spec,
		];
		const options = { cwd: work, encoding: "utf8" as const, maxBuffer: 256 * 1024 * 1024, timeout: TLC_TIMEOUT_MS };
		const started = Date.now();
		let result;
		if (how.kind === "java") result = spawnSync("java", args, options);
		else {
			const name = `evf-formal-${process.pid}-${Date.now()}`;
			const platform = process.arch === "arm64" ? "linux/arm64" : "linux/amd64";
			const env = { ...process.env, ...how.env };
			result = spawnSync(
				"docker",
				[
					"run",
					"--rm",
					"--name",
					name,
					"--platform",
					platform,
					"--user",
					`${process.getuid?.() ?? 0}`,
					"-v",
					`${work}:/model`,
					"-v",
					`${jar}:/tla2tools.jar:ro`,
					"-w",
					"/model",
					JAVA_IMAGE,
					"java",
					...args.map((a) => (a === jar ? "/tla2tools.jar" : a)),
				],
				{ ...options, env },
			);
			if (result.error) spawnSync("docker", ["rm", "-f", name], { env, stdio: "ignore" });
		}
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		if (result.error) throw new FormalError(`TLC on ${dir} did not finish: ${result.error.message}\n${output}`);
		return {
			config: readFileSync(join(dir, config), "utf8"),
			output,
			status: result.status ?? 1,
			ms: Date.now() - started,
			variables: sim ? sim.variables : [],
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

function checkedNames(config: string) {
	const text = config.replace(/\\\*.*$/gm, "");
	const names = { invariants: [] as string[], properties: [] as string[] };
	let section: keyof typeof names | null = null;
	for (const token of text.split(/\s+/).filter(Boolean)) {
		if (/^INVARIANTS?$/.test(token)) section = "invariants";
		else if (/^(?:PROPERTY|PROPERTIES)$/.test(token)) section = "properties";
		else if (/^[A-Z_]+$/.test(token)) section = null;
		else if (section) names[section].push(token);
	}
	return names;
}

function outcomes(output: string): string[][] | null {
	const start = output.indexOf('<< "outcomes",');
	if (start < 0) return null;
	let depth = 0,
		end = start;
	for (; end < output.length; end++) {
		if (output.startsWith("<<", end)) (depth++, end++);
		else if (output.startsWith(">>", end)) {
			end++;
			if (--depth === 0) break;
		}
	}
	const json = output
		.slice(start, end + 1)
		.replaceAll("<<", "[")
		.replaceAll(">>", "]")
		.replaceAll("{", "[")
		.replaceAll("}", "]");
	const rows = (JSON.parse(json) as [string, string[][]])[1];
	return rows.map((r) => r.map(String)).sort((a, b) => (a.join(" ") < b.join(" ") ? -1 : 1));
}

type Value = string | number | boolean | Value[] | { [key: string]: Value };
type State = Record<string, Value>;

const TOKEN = /\s*(<<|>>|\|->|:>|@@|[[\](){},]|"(?:[^"\\]|\\.)*"|-?\d+|[A-Za-z_]\w*)/y;

function printedValue(text: string, from: number): Value {
	TOKEN.lastIndex = from;
	const take = (want?: string) => {
		const at = TOKEN.lastIndex,
			m = TOKEN.exec(text);
		if (!m || (want !== undefined && m[1] !== want))
			throw new FormalError(`Cannot read TLC's output: expected ${want ?? "a value"} at ${text.slice(at, at + 40)}`);
		return m[1]!;
	};
	const peek = () => {
		const at = TOKEN.lastIndex,
			t = TOKEN.exec(text)?.[1];
		TOKEN.lastIndex = at;
		return t;
	};
	const list = <T>(close: string, sep: string, item: () => T) => {
		const items: T[] = [];
		if (peek() === close) return (take(), items);
		for (;;) {
			items.push(item());
			const t = take();
			if (t === close) return items;
			if (t !== sep) throw new FormalError(`Cannot read TLC's output: expected ${sep} or ${close}, found ${t}`);
		}
	};
	const value = (): Value => {
		const t = take();
		if (t === "<<" || t === "{") return list(t === "<<" ? ">>" : "}", ",", value);
		if (t === "[") return Object.fromEntries(list("]", ",", () => [take(), (take("|->"), value())]));
		if (t === "(") return Object.fromEntries(list(")", "@@", () => [String(value()), (take(":>"), value())]));
		if (t.startsWith('"')) return JSON.parse(t) as string;
		if (/^-?\d+$/.test(t)) return Number(t);
		if (t === "TRUE" || t === "FALSE") return t === "TRUE";
		if (/^[A-Za-z_]/.test(t)) return t;
		throw new FormalError(`Cannot read TLC's output: unexpected ${t}`);
	};
	return value();
}

const id = (v: Value): Value =>
	Array.isArray(v)
		? v.length && v.every((x) => typeof x !== "object")
			? v.join("/")
			: v.map(id)
		: typeof v === "object"
			? sorted(Object.entries(v).map(([k, x]) => [k, id(x)]))
			: v;
const sorted = (entries: [string, Value][]) =>
	Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

function printedBehaviors(output: string, variables: readonly string[]): State[][] {
	const behaviors: State[][] = [];
	let previous = -1;
	for (let at = output.indexOf(STATE_MARK); at >= 0; at = output.indexOf(STATE_MARK, at + 1)) {
		const [, level, values] = printedValue(output, at) as [string, number, Value[][][]];
		const state: State = Object.fromEntries(
			variables.map((name, i) => [name, sorted(values[i]!.map(([k, v]) => [String(id(k!)), id(v!)]))]),
		);
		const last = behaviors.at(-1)?.at(-1);
		if (level === previous) {
			if (JSON.stringify(state) !== JSON.stringify(last))
				throw new FormalError(`TLC printed two different states at level ${level} of behavior ${behaviors.length}.`);
			continue;
		}
		if (level < previous || !behaviors.length) behaviors.push(level === 0 ? [] : [behaviors[0]![0]!]);
		previous = level;
		behaviors.at(-1)!.push(state);
	}
	return behaviors;
}

type TraceStep = {
	action: string;
	args: Record<string, Value>;
	ok?: boolean;
	after: Record<string, Record<string, Value>>;
};

function permissionStep(after: State): Omit<TraceStep, "after"> {
	const last = after.last as Record<string, Value>;
	const op = String(last.op),
		session = last.session!,
		target = String(last.target);
	const seatOps = ["appointAdmin", "demote", "changeOrdinaryRole", "remove"];
	if (op === "signIn") return { action: "SignIn", args: { session } };
	if (op === "endSession") return { action: "EndSession", args: { session } };
	if (seatOps.includes(op)) {
		const seat = (after.seats as Record<string, Record<string, Value>>)[target]!;
		return { action: "SeatAction", args: { session, op, to: op === "remove" ? "none" : seat.role!, target } };
	}
	if (op === "invite") {
		const i = (after.invitations as Record<string, Record<string, Value>>)[target]!;
		return { action: "Invite", args: { session, invitation: target, workspace: i.ws!, role: i.role!, to: i.to! } };
	}
	if (op === "revoke") return { action: "Revoke", args: { session, invitation: target } };
	if (op === "accept") return { action: "Accept", args: { session, invitation: target } };
	if (op === "expire") return { action: "Expire", args: { invitation: target } };
	if (op === "resolve") {
		const kind = (after.requests as Record<string, Record<string, Value>>)[target]!.kind!;
		return { action: "Resolve", args: { request: target, session, kind } };
	}
	if (["read", "adminRead", "write"].includes(op))
		return { action: "Run", args: { request: target, kind: op }, ok: last.ok === true };
	throw new FormalError(
		`The model's step "${op}" maps to no action. Add it to permissionStep in tools/formal/formal.ts.`,
	);
}

function permissionCoverage(step: Omit<TraceStep, "after">) {
	if (step.action === "SeatAction")
		return `SeatAction ${step.args.op}${step.args.op === "changeOrdinaryRole" ? ` to ${step.args.to}` : ""}`;
	if (step.action === "Run") return `Run ${step.args.kind} ${step.ok ? "admitted" : "refused"}`;
	return step.action;
}

const SIMULATIONS: Record<
	string,
	Simulate & {
		step: (after: State) => Omit<TraceStep, "after">;
		coverage: (step: Omit<TraceStep, "after">) => string;
		covers: readonly string[];
	}
> = {
	MCPermissions: {
		traces: 40,
		depth: 30,
		seed: 399,
		step: permissionStep,
		coverage: permissionCoverage,
		covers: [
			"SignIn",
			"EndSession",
			"SeatAction appointAdmin",
			"SeatAction demote",
			"SeatAction changeOrdinaryRole to admin",
			"SeatAction changeOrdinaryRole to member",
			"SeatAction remove",
			"Invite",
			"Revoke",
			"Expire",
			"Accept",
			"Resolve",
			...["read", "adminRead", "write"].flatMap((k) => [`Run ${k} admitted`, `Run ${k} refused`]),
		],
	},
};

const simulationOf = (dir: string) => SIMULATIONS[globSync("MC*.cfg", { cwd: dir })[0]?.replace(/\.cfg$/, "") ?? ""];

function nextActions(tla: string) {
	const defined = new Set([...tla.matchAll(/^([A-Za-z]\w*)(?:\([^)]*\))?\s*==/gm)].map((m) => m[1]!));
	const next = /^Next\s*==([\s\S]*?)^\S/m.exec(tla)?.[1] ?? "";
	return [...new Set([...next.matchAll(/\b([A-Z]\w*)\(/g)].map((m) => m[1]!))].filter((n) => defined.has(n));
}

function generateTraces(dir: string, jar: string, how: Runner, seed: number) {
	const sim = simulationOf(dir)!;
	const run = tlc(dir, jar, how, { ...sim, seed });
	if (!/Computed 1 initial states?\b/.test(run.output))
		throw new FormalError(`${dir} has more than one initial state; its behaviors cannot share one start.`);
	const behaviors = run.status === 0 ? printedBehaviors(run.output, run.variables) : [];
	if (behaviors.length !== sim.traces) {
		const error = run.output.indexOf("Error:");
		throw new FormalError(
			`TLC simulation of ${dir} printed ${behaviors.length} of ${sim.traces} behaviors.${error >= 0 ? `\n${run.output.slice(error)}` : ""}`,
		);
	}
	const init = behaviors[0]![0]!;
	const { last: _, ...start } = init;
	const covered = new Set<string>();
	const steps = behaviors.map((states) =>
		states.slice(1).map((after, k) => {
			const before = states[k]!;
			const step = sim.step(after);
			covered.add(sim.coverage(step));
			const changed: TraceStep["after"] = {};
			for (const [name, value] of Object.entries(after)) {
				if (name === "last") continue;
				const was = before[name] as Record<string, Value>;
				for (const [key, v] of Object.entries(value as Record<string, Value>))
					if (JSON.stringify(v) !== JSON.stringify(was[key])) (changed[name] ??= {})[key] = v;
			}
			return { ...step, after: changed };
		}),
	);
	const tla = globSync("*.tla", { cwd: dir })
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.join("\n");
	const listed = new Set(sim.covers.map((c) => c.split(" ")[0]));
	const missing = [...nextActions(tla).filter((a) => !listed.has(a)), ...sim.covers.filter((c) => !covered.has(c))];
	const count = steps.reduce((n, s) => n + s.length, 0);
	const text = `{\n\t"generatedBy": "bin/dev formal --write",\n\t"seed": ${seed},\n\t"traces": ${sim.traces},\n\t"depth": ${sim.depth},\n\t"init": ${JSON.stringify(start)},\n\t"behaviors": [\n${steps.map((b) => `\t\t[\n${b.map((s) => `\t\t\t${JSON.stringify(s)}`).join(",\n")}\n\t\t]`).join(",\n")}\n\t]\n}\n`;
	return { text, traces: steps.length, steps: count, missing, ms: run.ms };
}

function checkModel(dir: string, jar: string, how: Runner, write: boolean) {
	const lines: string[] = [];
	const run = tlc(dir, jar, how);
	const names = checkedNames(run.config);
	const states = /([\d,]+) states generated, ([\d,]+) distinct states found/.exec(run.output);
	const violated = /Error: (?:Invariant|Action property|Property|Temporal properties?) (\w+)?/.exec(run.output);
	const passed = run.status === 0 && /Model checking completed\. No error has been found\./.test(run.output);
	lines.push(`${dir}: TLC ${TLA_TOOLS.version}, ${(run.ms / 1000).toFixed(1)} s`);
	if (!passed) {
		const failed = violated?.[1];
		for (const n of [...names.invariants, ...names.properties])
			lines.push(`  ${n === failed ? "FAILED" : failed ? "stopped" : "unknown"}  ${n}`);
		const error = run.output.indexOf("Error:");
		lines.push(`  TLC found a violation${failed ? ` of ${failed}` : ""}. Its trace:`, "");
		lines.push(error >= 0 ? run.output.slice(error) : run.output);
		return { lines, ok: false };
	}
	for (const n of names.invariants) lines.push(`  passed  invariant ${n}`);
	for (const n of names.properties) lines.push(`  passed  property  ${n}`);
	lines.push(`  ${states ? `${states[2]} distinct states (${states[1]} generated)` : "state count not printed"}`);
	let ok = true;
	const table = outcomes(run.output);
	if (table)
		ok &&= current(
			lines,
			join(dir, "outcomes.json"),
			`{\n\t"generatedBy": "bin/dev formal --write",\n\t"rows": [\n${table.map((r) => `\t\t${JSON.stringify(r)}`).join(",\n")}\n\t]\n}\n`,
			`${table.length} rows`,
			"the conformance test",
			write,
		);
	const sim = simulationOf(dir);
	if (sim) {
		const traces = generateTraces(dir, jar, how, sim.seed);
		lines.push(
			`  TLC simulation: ${traces.traces} traces, ${traces.steps} steps, depth ${sim.depth}, seed ${sim.seed} (${(traces.ms / 1000).toFixed(1)} s)`,
		);
		if (traces.missing.length) {
			lines.push(
				`  the traces leave out: ${traces.missing.join(", ")}. Raise traces or depth in SIMULATIONS (tools/formal/formal.ts), or list a new action there.`,
			);
			return { lines, ok: false };
		}
		lines.push(`  the traces cover every action: ${sim.covers.join(", ")}`);
		ok &&= current(lines, join(dir, "traces.json"), traces.text, `${traces.traces} traces`, "the replay test", write);
	}
	return { lines, ok };
}

function current(lines: string[], file: string, text: string, size: string, test: string, write: boolean) {
	const name = basename(file);
	if (existsSync(file) && readFileSync(file, "utf8") === text) {
		lines.push(`  ${name} matches the model (${size})`);
		return true;
	}
	if (write) {
		writeFileSync(file, text);
		lines.push(`  wrote ${name} (${size})`);
		return true;
	}
	lines.push(`  ${file} is stale: the model generates a different file. Rerun with --write, then run ${test}.`);
	return false;
}

function freshTraces(dirs: string[], out: string, seed: number, jar: string, how: Runner, root: string) {
	let ok = true;
	for (const dir of dirs.filter((d) => simulationOf(d))) {
		const traces = generateTraces(dir, jar, how, seed);
		const file = join(out, basename(dir), "traces.json");
		console.log(
			`${relative(root, dir)}: TLC simulation from seed ${seed}: ${traces.traces} traces, ${traces.steps} steps`,
		);
		if (traces.missing.length) console.log(`  the traces leave out: ${traces.missing.join(", ")}. Try another seed.`);
		ok &&= !traces.missing.length;
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, traces.text);
		console.log(`  wrote ${file}`);
	}
	console.log(`Replay them: FORMAL_TRACES=${out} (see .agents/skills/formal-permissions/SKILL.md)`);
	return ok;
}

type MapEntry = { name: string; code: { file: string; function: string }[]; ids: string[] };
type FormalMap = {
	model: string;
	generated?: string[];
	tests?: string[];
	actions: MapEntry[];
	rules?: MapEntry[];
	properties: MapEntry[];
};

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function defines(source: string, name: string) {
	const n = escape(name);
	return [
		new RegExp(`\\bfunction\\s+${n}\\b`),
		new RegExp(`\\b(?:const|let|var|class)\\s+${n}\\b`),
		new RegExp(`^\\s*(?:static\\s+)?(?:async\\s+)?${n}\\s*\\(`, "m"),
		new RegExp(`^\\s*${n}\\s*:`, "m"),
		new RegExp(`\\bFUNCTION\\s+${n}\\s*\\(`, "i"),
		new RegExp(`\\bINDEX\\s+"${n}"`, "i"),
	].some((re) => re.test(source));
}

export function mapProblems(root: string, mapFile: string): string[] {
	const map = JSON.parse(readFileSync(join(root, mapFile), "utf8")) as FormalMap;
	const problems: string[] = [];
	const dir = join(root, map.model);
	if (!existsSync(dir)) return [`${mapFile}: model ${map.model} does not exist`];
	for (const file of [...(map.generated ?? []), ...(map.tests ?? [])])
		if (!existsSync(join(root, file))) problems.push(`${mapFile}: ${file} does not exist`);
	const tla = globSync("*.tla", { cwd: dir })
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.join("\n");
	const defined = new Set([...tla.matchAll(/^([A-Za-z]\w*)(?:\([^)]*\))?\s*==/gm)].map((m) => m[1]!));
	const config = globSync("MC*.cfg", { cwd: dir }).map((f) => readFileSync(join(dir, f), "utf8"));
	const checked = config.flatMap((c) => {
		const n = checkedNames(c);
		return [...n.invariants, ...n.properties];
	});
	const actions = nextActions(tla);
	const mapped = (list: MapEntry[]) => new Set(list.map((e) => e.name));
	for (const a of actions)
		if (!mapped(map.actions).has(a)) problems.push(`${mapFile}: action ${a} in Next is not mapped`);
	for (const p of checked)
		if (!mapped(map.properties).has(p)) problems.push(`${mapFile}: checked property ${p} is not mapped`);
	const decisions = readFileSync(join(root, "docs/architecture/decisions.md"), "utf8");
	const requirements = globSync("docs/catalog/requirements/*.json", { cwd: root })
		.map((f) => readFileSync(join(root, f), "utf8"))
		.join("\n");
	for (const e of [...map.actions, ...(map.rules ?? []), ...map.properties]) {
		if (!defined.has(e.name)) problems.push(`${mapFile}: ${e.name} is not defined in ${map.model}`);
		if (!e.code.length) problems.push(`${mapFile}: ${e.name} names no code`);
		for (const c of e.code) {
			const file = join(root, c.file);
			if (!existsSync(file)) problems.push(`${mapFile}: ${e.name}: ${c.file} does not exist`);
			else if (!defines(readFileSync(file, "utf8"), c.function))
				problems.push(`${mapFile}: ${e.name}: ${c.file} no longer defines ${c.function}`);
		}
		if (!e.ids.length) problems.push(`${mapFile}: ${e.name} names no requirement or decision id`);
		for (const id of e.ids) {
			const known = id.startsWith("REQ-")
				? requirements.includes(`"${id}"`)
				: new RegExp(`^## ${escape(id)}[, ]`, "m").test(decisions);
			if (!known) problems.push(`${mapFile}: ${e.name}: unknown id ${id}`);
		}
	}
	return problems;
}

export async function formalCommand(args: readonly string[], root: string): Promise<number> {
	try {
		return await formal(args, root);
	} catch (error) {
		if (!(error instanceof FormalError)) throw error;
		console.error(`formal: ${error.message}`);
		return 1;
	}
}

const USAGE =
	"Usage: bin/dev formal [--write] [<model dir>...] | bin/dev formal --traces <dir outside the repo> [--seed <n>]";

async function formal(args: readonly string[], root: string): Promise<number> {
	const write = args.includes("--write");
	const valued = new Map<string, string>(),
		given: string[] = [],
		unknown: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a === "--traces" || a === "--seed") valued.set(a, args[++i] ?? "");
		else if (a === "--write") continue;
		else if (a.startsWith("--")) unknown.push(a);
		else given.push(a);
	}
	if (unknown.length) {
		console.error(`formal: unknown option ${unknown.join(" ")}. ${USAGE}`);
		return 2;
	}
	const dirs = given.length
		? given.map((d) => resolve(d))
		: globSync("formal/*/", { cwd: root })
				.map((d) => resolve(root, d))
				.sort();
	if (!dirs.length) throw new FormalError("No formal models under formal/.");
	const out = valued.get("--traces"),
		seedText = valued.get("--seed");
	if (seedText !== undefined && (out === undefined || !/^\d{1,15}$/.test(seedText))) {
		console.error(`formal: --seed takes a whole number and goes with --traces. ${USAGE}`);
		return 2;
	}
	if (out !== undefined) {
		const target = resolve(out);
		if (!out || write || !relative(root, target).startsWith("..")) {
			console.error(`formal: --traces takes a directory outside the repository, without --write. ${USAGE}`);
			return 2;
		}
		const seed = seedText === undefined ? randomInt(1, 2 ** 47) : Number(seedText);
		return freshTraces(dirs, target, seed, await tlaTools(), runner(), root) ? 0 : 1;
	}
	const started = Date.now();
	let ok = true;
	const problems = globSync(".agents/skills/formal-*/map.json", { cwd: root }).flatMap((m) => mapProblems(root, m));
	if (problems.length) ok = false;
	console.log(problems.length ? `map check failed:\n  ${problems.join("\n  ")}` : "map check passed");
	const jar = await tlaTools();
	const how = runner();
	console.log(`TLC runs on ${how.kind === "java" ? "the local Java" : `Docker (${JAVA_IMAGE})`}`);
	for (const dir of dirs) {
		const result = checkModel(dir, jar, how, write);
		console.log(result.lines.join("\n").replaceAll(dir, relative(root, dir) || basename(dir)));
		ok &&= result.ok;
	}
	console.log(`formal: ${ok ? "passed" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
	return ok ? 0 : 1;
}

if (import.meta.main) {
	process.exit(await formalCommand(process.argv.slice(2), resolve(import.meta.dirname, "../..")));
}
