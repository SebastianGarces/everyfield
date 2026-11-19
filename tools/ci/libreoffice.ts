import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

const PACKAGES = ["libreoffice-writer", "libreoffice-calc"];
const ATTEMPTS = 3;
const ACQUIRE = ["-o", "Acquire::Retries=1", "-o", "Acquire::http::Timeout=10", "-o", "Acquire::https::Timeout=10"];

type Run = { ok: boolean; output: string };

const { values } = parseArgs({
	options: {
		arch: { type: "string" },
		debs: { type: "string", default: join(homedir(), "libreoffice-debs") },
		"retry-wait": { type: "string", default: "10" },
	},
});
const arch = values.arch;
const debs = values.debs;
const retryWait = Number(values["retry-wait"]);
const githubOutput = process.env.GITHUB_OUTPUT;
if (!arch || !githubOutput || !Number.isFinite(retryWait) || retryWait < 0) {
	process.stderr.write(
		"usage: GITHUB_OUTPUT=<file> node tools/ci/libreoffice.ts --arch <runner.arch> [--debs <dir>] [--retry-wait <seconds>]\n",
	);
	process.exit(2);
}
const cache = [
	"-o",
	`Dir::Cache::Archives=${debs}`,
	"-o",
	"APT::Keep-Downloaded-Packages=true",
	"-o",
	"APT::Sandbox::User=root",
];

function sudo(args: string[]): Promise<Run> {
	return new Promise((resolve) => {
		const child = spawn("sudo", args, { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk;
			process.stdout.write(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk;
			process.stderr.write(chunk);
		});
		child.on("error", (error) => resolve({ ok: false, output: output + String(error) }));
		child.on("close", (code) => resolve({ ok: code === 0, output }));
	});
}

async function retried(label: string, args: string[]): Promise<Run> {
	let run: Run = { ok: false, output: "" };
	for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
		run = await sudo(["apt-get", ...args]);
		if (run.ok) return run;
		if (attempt < ATTEMPTS) {
			const wait = retryWait * attempt;
			console.log(`::warning::${label} failed (attempt ${attempt} of ${ATTEMPTS}); retrying in ${wait}s.`);
			await sleep(wait * 1000);
		}
	}
	console.log(`::warning::${label} failed ${ATTEMPTS} times.`);
	return run;
}

function cachedDebs(): string[] {
	return readdirSync(debs, { withFileTypes: true })
		.filter((entry) => entry.isFile() && entry.name.endsWith(".deb"))
		.map((entry) => entry.name)
		.sort();
}

const order = (c: string): number =>
	c === "~" ? -1 : c === "" ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256;

function comparePart(a: string, b: string): number {
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		while ((i < a.length && !/\d/.test(a[i])) || (j < b.length && !/\d/.test(b[j]))) {
			const x = i < a.length && !/\d/.test(a[i]) ? a[i] : "";
			const y = j < b.length && !/\d/.test(b[j]) ? b[j] : "";
			if (order(x) !== order(y)) return order(x) - order(y);
			if (x) i++;
			if (y) j++;
		}
		const da = /^\d*/.exec(a.slice(i))![0];
		const db = /^\d*/.exec(b.slice(j))![0];
		i += da.length;
		j += db.length;
		const diff = Number(da || 0) - Number(db || 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

function compareVersions(a: string, b: string): number {
	const split = (v: string) => {
		const colon = v.indexOf(":");
		const epoch = colon === -1 ? 0 : Number(v.slice(0, colon));
		const rest = v.slice(colon + 1);
		const dash = rest.lastIndexOf("-");
		return {
			epoch,
			upstream: dash === -1 ? rest : rest.slice(0, dash),
			revision: dash === -1 ? "" : rest.slice(dash + 1),
		};
	};
	const x = split(a);
	const y = split(b);
	return x.epoch - y.epoch || comparePart(x.upstream, y.upstream) || comparePart(x.revision, y.revision);
}

function installedVersions(): Map<string, string> {
	const query = spawnSync("dpkg-query", ["-W", "-f", "${Package} ${Version}\\n"], { encoding: "utf8" });
	const versions = new Map<string, string>();
	for (const line of (query.stdout ?? "").split("\n")) {
		const [name, version] = line.split(" ");
		if (name && version) versions.set(name, version);
	}
	return versions;
}

function newestOfEach(files: string[]): string[] {
	const installed = installedVersions();
	const newest = new Map<string, { file: string; version: string }>();
	for (const file of files) {
		const [name, encoded, archDeb] = file.split("_");
		if (!name || !encoded || !archDeb) continue;
		const version = decodeURIComponent(encoded);
		const present = installed.get(name);
		if (present && compareVersions(version, present) <= 0) continue;
		const key = `${name}_${archDeb}`;
		const seen = newest.get(key);
		if (!seen || compareVersions(version, seen.version) > 0) newest.set(key, { file, version });
	}
	return [...newest.values()].map((entry) => entry.file).sort();
}

function missingPackages(output: string): string[] {
	const names = new Set<string>();
	const patterns = [
		/Failed to fetch \S*\/([^/\s_]+)_[^/\s]*\.deb/g,
		/Unable to locate package (\S+)/g,
		/Depends: (\S+) but it is not (?:installable|going to be installed)/g,
		/Package '?([^'\s]+)'? has no installation candidate/g,
	];
	for (const pattern of patterns) for (const match of output.matchAll(pattern)) names.add(match[1]);
	return [...names].sort();
}

mkdirSync(join(debs, "partial"), { recursive: true });
console.log(`Restored ${cachedDebs().length} cached packages.`);

const refreshed = (await retried("apt index refresh", ["update", "--error-on=any", ...ACQUIRE])).ok;
let installed =
	refreshed &&
	(
		await retried("LibreOffice install", [
			"install",
			"-y",
			"--no-install-recommends",
			...cache,
			...ACQUIRE,
			...PACKAGES,
		])
	).ok;
if (!installed) {
	const local = newestOfEach(cachedDebs());
	console.log(
		`${refreshed ? "The install failed" : "The apt index could not be refreshed"}; installing from the ${local.length} cached packages, with the mirror only for any they lack.`,
	);
	const fallback = await retried("LibreOffice install from the cache", [
		"install",
		"-y",
		"--no-install-recommends",
		...cache,
		...ACQUIRE,
		...local.map((file) => join(debs, file)),
		...PACKAGES,
	]);
	installed = fallback.ok;
	if (!installed) {
		const missing = missingPackages(fallback.output);
		console.log(
			`::error::LibreOffice could not be installed: ${missing.length > 0 ? `could not get ${missing.join(", ")} from the cache or the mirror` : "apt named no missing package; see its output above"}.`,
		);
		process.exit(1);
	}
}

if (refreshed) {
	const clean = await sudo(["apt-get", ...cache, "autoclean"]);
	if (!clean.ok) process.exit(1);
}
spawnSync("sudo", ["rm", "-rf", join(debs, "partial"), join(debs, "lock")], { stdio: "inherit" });
spawnSync("sudo", ["chown", "-R", `${process.getuid!()}:${process.getgid!()}`, debs], { stdio: "inherit" });

const files = cachedDebs();
const bytes = files.reduce((sum, file) => sum + statSync(join(debs, file)).size, 0);
console.log(`Caching ${files.length} packages, ${Math.round(bytes / 1048576)}M.`);
const hash = createHash("sha256")
	.update(files.map((file) => `${file}\n`).join(""))
	.digest("hex")
	.slice(0, 16);
appendFileSync(githubOutput, `key=libreoffice-debs-ubuntu-24.04-${arch}-writer-calc-v2-${hash}\n`);
