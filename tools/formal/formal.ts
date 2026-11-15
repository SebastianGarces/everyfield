// `bin/dev formal [--write] [<model dir>...]`: the formal checks (T-398). For every model under formal/ (or the dirs
// given), it runs TLC on the model's MC*.cfg with a pinned tla2tools.jar whose checksum it verifies, prints each
// invariant and property with its result and the distinct states TLC explored, and prints TLC's counterexample when a
// property fails. It then checks the outcome table the model prints against the committed outcomes.json (--write
// rewrites it) and checks every map in .agents/skills/formal-*/map.json against the code and the model.
//
// TLC runs on a local Java 11 or newer when there is one, and otherwise in a pinned Java container through Docker.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { basename, join, relative, resolve } from "node:path";

const TLA_TOOLS = {
	version: "1.7.4",
	url: "https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar",
	sha256: "936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88",
};
/** eclipse-temurin:21-jre, pinned by its multi-platform index digest. */
const JAVA_IMAGE = "eclipse-temurin@sha256:18bb4a91a3dea3f03ee31d3755af34dfb40f904fc77ab56cdc2f092e32fff9c2";
/** A run that takes longer than this is a hang, not a slow model: the spec's budget is 3 minutes. */
const TLC_TIMEOUT_MS = 10 * 60 * 1000;

class FormalError extends Error {
	name = "FormalError";
}

const cacheDir = (env = process.env) =>
	env.EVERYFIELD_FORMAL_CACHE ?? join(homedir(), ".cache", "everyfield", "formal");
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** The pinned jar in the cache, downloaded once and verified by checksum on every run. */
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

/** A local Java 11 or newer, or else a Docker endpoint that answers. */
function runner(): Runner {
	const java = spawnSync("java", ["-version"], { encoding: "utf8" });
	const version = /version "(\d+)/.exec(`${java.stderr ?? ""}${java.stdout ?? ""}`);
	if (java.status === 0 && version && Number(version[1]) >= 11) return { kind: "java" };
	// An empty client config: a public image needs no credential helper, and a missing helper fails the pull.
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

/** Runs TLC on one model dir's MC*.cfg in a temporary copy, so TLC's state files never land in the repository. */
function tlc(dir: string, jar: string, how: Runner) {
	const configs = globSync("MC*.cfg", { cwd: dir });
	if (configs.length !== 1) throw new FormalError(`${dir} needs exactly one MC*.cfg; it has ${configs.length}.`);
	const config = configs[0]!,
		spec = config.replace(/\.cfg$/, ".tla");
	if (!existsSync(join(dir, spec))) throw new FormalError(`${dir}/${config} has no ${spec} beside it.`);
	// Under the cache, in the home folder: Docker on macOS (colima) shares only the home folder with its VM.
	const work = mkdtempSync(join(cacheDir(), "run-"));
	try {
		for (const file of globSync("*.{tla,cfg}", { cwd: dir })) cpSync(join(dir, file), join(work, file));
		const args = [
			"-XX:+UseParallelGC",
			"-jar",
			jar,
			"-workers",
			"auto",
			"-deadlock",
			"-cleanup",
			"-config",
			config,
			spec,
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
			// A timed-out client leaves its container running: stop it by the name this run gave it.
			if (result.error) spawnSync("docker", ["rm", "-f", name], { env, stdio: "ignore" });
		}
		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		if (result.error) throw new FormalError(`TLC on ${dir} did not finish: ${result.error.message}\n${output}`);
		return {
			config: readFileSync(join(dir, config), "utf8"),
			output,
			status: result.status ?? 1,
			ms: Date.now() - started,
		};
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

/** The names a TLC config checks, by section. */
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

/** The outcome table a model prints as `<<"outcomes", {...}>>`, sorted, or null when it prints none. */
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

/** Checks one model dir. Returns the lines to print and whether it passed. */
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
	const table = outcomes(run.output);
	if (!table) return { lines, ok: true };
	const file = join(dir, "outcomes.json");
	// One row per line, so a changed outcome reads as a one-line diff.
	const text = `{\n\t"generatedBy": "bin/dev formal --write",\n\t"rows": [\n${table.map((r) => `\t\t${JSON.stringify(r)}`).join(",\n")}\n\t]\n}\n`;
	const current = existsSync(file) ? readFileSync(file, "utf8") : null;
	if (current === text) {
		lines.push(`  outcomes.json matches the model (${table.length} rows)`);
		return { lines, ok: true };
	}
	if (write) {
		writeFileSync(file, text);
		lines.push(`  wrote outcomes.json (${table.length} rows)`);
		return { lines, ok: true };
	}
	lines.push(`  outcomes.json is stale: the model's table differs. Rerun with --write, then run the conformance test.`);
	return { lines, ok: false };
}

type MapEntry = { name: string; code: { file: string; function: string }[]; ids: string[] };
type FormalMap = { model: string; actions: MapEntry[]; rules?: MapEntry[]; properties: MapEntry[] };

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whether `source` defines `name`: a function, a const, a method, an object property, or SQL. */
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

/** Problems with one map: unmapped or unknown model names, missing code, unknown ids. */
export function mapProblems(root: string, mapFile: string): string[] {
	const map = JSON.parse(readFileSync(join(root, mapFile), "utf8")) as FormalMap;
	const problems: string[] = [];
	const dir = join(root, map.model);
	if (!existsSync(dir)) return [`${mapFile}: model ${map.model} does not exist`];
	const tla = globSync("*.tla", { cwd: dir })
		.map((f) => readFileSync(join(dir, f), "utf8"))
		.join("\n");
	const defined = new Set([...tla.matchAll(/^([A-Za-z]\w*)(?:\([^)]*\))?\s*==/gm)].map((m) => m[1]!));
	const config = globSync("MC*.cfg", { cwd: dir }).map((f) => readFileSync(join(dir, f), "utf8"));
	const checked = config.flatMap((c) => {
		const n = checkedNames(c);
		return [...n.invariants, ...n.properties];
	});
	const next = /^Next\s*==([\s\S]*?)^\S/m.exec(tla)?.[1] ?? "";
	const actions = [...new Set([...next.matchAll(/\b([A-Z]\w*)\(/g)].map((m) => m[1]!))].filter((n) => defined.has(n));
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

async function formal(args: readonly string[], root: string): Promise<number> {
	const write = args.includes("--write");
	const given = args.filter((a) => !a.startsWith("--"));
	const unknown = args.filter((a) => a.startsWith("--") && a !== "--write");
	if (unknown.length) {
		console.error(`formal: unknown option ${unknown.join(" ")}. Usage: bin/dev formal [--write] [<model dir>...]`);
		return 2;
	}
	const dirs = given.length
		? given.map((d) => resolve(d))
		: globSync("formal/*/", { cwd: root })
				.map((d) => resolve(root, d))
				.sort();
	if (!dirs.length) throw new FormalError("No formal models under formal/.");
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
