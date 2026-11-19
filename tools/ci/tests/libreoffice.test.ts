import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tool = resolve(import.meta.dirname, "../libreoffice.ts");

const fakeApt = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const dir = process.env.FAKE_APT;
const config = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
const statePath = path.join(dir, 'state.json');
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : { updates: 0, fetches: 0, fresh: false, downloaded: [] };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, 'calls.jsonl'), JSON.stringify(args) + '\\n');
const options = {};
const words = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') { const [k, ...v] = args[++i].split('='); options[k] = v.join('='); continue; }
  if (!args[i].startsWith('-')) words.push(args[i]);
}
const command = words[0];
const archives = options['Dir::Cache::Archives'];
const want = () => (state.fresh ? config.fresh : config.stale);
const name = (file) => path.basename(file).split('_')[0];
if (command === 'update') {
  state.updates++;
  if (state.updates <= config.updateFailures) {
    save();
    console.log('Err:1 http://archive.ubuntu.com/ubuntu noble InRelease\\n  503  Service Unavailable [IP: 192.0.2.1 80]');
    console.log('W: Some index files failed to download. They have been ignored, or old ones used instead.');
    if (args.includes('--error-on=any')) { console.error('E: Some index files failed to download.'); process.exit(100); }
    process.exit(0);
  }
  state.fresh = true;
  save();
  console.log('Reading package lists... Done');
  process.exit(0);
}
if (command === 'install') {
  const local = words.slice(1).filter((w) => w.endsWith('.deb'));
  for (const file of local) if (!fs.existsSync(file)) { console.error('E: Unsupported file ' + file); process.exit(100); }
  const needs = want().filter((file) => !local.some((l) => name(l) === name(file)) && !fs.existsSync(path.join(archives, file)));
  if (needs.length > 0) {
    state.fetches++;
    if (state.fetches <= config.fetchFailures) {
      save();
      for (const file of needs) console.error('E: Failed to fetch http://security.ubuntu.com/ubuntu/pool/main/x/' + name(file) + '/' + file + '  503  Service Unavailable [IP: 192.0.2.1 80]');
      console.error('E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?');
      process.exit(100);
    }
    for (const file of needs) { fs.writeFileSync(path.join(archives, file), file); state.downloaded.push(file); }
  }
  save();
  console.log('Need to get ' + needs.length + ' files of archives.');
  process.exit(0);
}
if (command === 'autoclean') {
  for (const file of fs.readdirSync(archives)) if (file.endsWith('.deb') && !want().includes(file)) fs.rmSync(path.join(archives, file));
  process.exit(0);
}
process.exit(64);
`;

type Config = {
	stale: string[];
	fresh: string[];
	cached: string[];
	updateFailures: number;
	fetchFailures: number;
	installed?: Record<string, string>;
};

function run(config: Config) {
	const root = mkdtempSync(join(tmpdir(), "libreoffice-"));
	const bin = join(root, "bin");
	const debs = join(root, "debs");
	const fake = join(root, "fake");
	for (const dir of [bin, debs, fake]) mkdirSync(dir);
	writeFileSync(join(bin, "sudo"), '#!/bin/sh\nexec "$@"\n');
	writeFileSync(join(bin, "apt-get"), fakeApt);
	const installed = Object.entries(config.installed ?? {}).map(([n, v]) => `${n} ${v}`);
	writeFileSync(
		join(bin, "dpkg-query"),
		`#!/bin/sh\nprintf '%s\\n' ${installed.map((line) => `'${line}'`).join(" ")}\n`,
	);
	for (const file of ["sudo", "apt-get", "dpkg-query"]) chmodSync(join(bin, file), 0o755);
	writeFileSync(join(fake, "config.json"), JSON.stringify(config));
	for (const file of config.cached) writeFileSync(join(debs, file), file);
	const output = join(root, "github-output");
	writeFileSync(output, "");
	const result = spawnSync(process.execPath, [tool, "--arch", "X64", "--debs", debs, "--retry-wait", "0"], {
		encoding: "utf8",
		env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_APT: fake, GITHUB_OUTPUT: output },
	});
	const statePath = join(fake, "state.json");
	return {
		status: result.status,
		log: result.stdout + result.stderr,
		calls: readFileSync(join(fake, "calls.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as string[]),
		downloaded: existsSync(statePath) ? (JSON.parse(readFileSync(statePath, "utf8")).downloaded as string[]) : [],
		files: readdirSync(debs).sort(),
		githubOutput: readFileSync(output, "utf8"),
		debs,
	};
}

const keyOf = (files: string[]) =>
	`key=libreoffice-debs-ubuntu-24.04-X64-writer-calc-v2-${createHash("sha256")
		.update(files.map((f) => `${f}\n`).join(""))
		.digest("hex")
		.slice(0, 16)}\n`;
const command = (call: string[]) => call.find((word, i) => !word.startsWith("-") && call[i - 1] !== "-o");
const localDebs = (call: string[]) => call.filter((word) => word.endsWith(".deb"));

const GST_OLD = "libgstreamer-plugins-base1.0-0_1.24.2-1ubuntu0.6_amd64.deb";
const GST_NEW = "libgstreamer-plugins-base1.0-0_1.24.2-1ubuntu0.7_amd64.deb";
const WRITER = "libreoffice-writer_4%3a24.2.7-0ubuntu0.24.04.4_amd64.deb";
const CALC = "libreoffice-calc_4%3a24.2.7-0ubuntu0.24.04.4_amd64.deb";

test("with a working mirror it refreshes, installs writer and calc, downloads only what the cache lacks, autocleans and writes the key", () => {
	const r = run({
		stale: [GST_OLD, WRITER, CALC],
		fresh: [GST_NEW, WRITER, CALC],
		cached: [GST_OLD, WRITER],
		updateFailures: 0,
		fetchFailures: 0,
	});
	assert.equal(r.status, 0, r.log);
	assert.deepEqual(r.calls.map(command), ["update", "install", "autoclean"]);
	assert.ok(r.calls[0].includes("--error-on=any"));
	assert.deepEqual(r.calls[1].slice(-2), ["libreoffice-writer", "libreoffice-calc"]);
	assert.deepEqual(localDebs(r.calls[1]), []);
	assert.ok(r.calls[1].includes(`Dir::Cache::Archives=${r.debs}`));
	assert.deepEqual(r.downloaded, [GST_NEW, CALC]);
	assert.deepEqual(r.files, [CALC, GST_NEW, WRITER].sort());
	assert.equal(r.githubOutput, keyOf(r.files));
	assert.match(r.log, /Restored 2 cached packages\./);
	assert.match(r.log, /Caching 3 packages/);
});

test("when the index refresh fails and the mirror is down, it installs from the cached debs with no download (run 44522664573)", () => {
	const cached = [
		GST_NEW,
		WRITER,
		CALC,
		"libx_1.0-1_amd64.deb",
		"libx_1.0-1ubuntu0.1_amd64.deb",
		"liby_2.0~rc1-1_all.deb",
		"liby_2.0-1_all.deb",
		"libz_1.5-1_amd64.deb",
	];
	const r = run({
		stale: [GST_OLD, WRITER, CALC],
		fresh: [GST_NEW, WRITER, CALC],
		cached,
		updateFailures: 99,
		fetchFailures: 99,
		installed: { libz: "1.6-1" },
	});
	assert.equal(r.status, 0, r.log);
	assert.deepEqual(r.calls.map(command), ["update", "update", "update", "install"]);
	assert.deepEqual(
		localDebs(r.calls[3]).map((file) => file.slice(r.debs.length + 1)),
		[CALC, GST_NEW, WRITER, "libx_1.0-1ubuntu0.1_amd64.deb", "liby_2.0-1_all.deb"].sort(),
	);
	assert.deepEqual(r.calls[3].slice(-2), ["libreoffice-writer", "libreoffice-calc"]);
	assert.deepEqual(r.downloaded, []);
	assert.deepEqual(r.files, [...cached].sort());
	assert.equal(r.githubOutput, keyOf(r.files));
	assert.match(r.log, /apt index refresh failed \(attempt 1 of 3\)/);
	assert.match(r.log, /The apt index could not be refreshed; installing from the 5 cached packages/);
});

test("short mirror failures are retried for the index refresh and the downloads", () => {
	const r = run({
		stale: [GST_OLD, WRITER, CALC],
		fresh: [GST_NEW, WRITER, CALC],
		cached: [WRITER, CALC],
		updateFailures: 1,
		fetchFailures: 2,
	});
	assert.equal(r.status, 0, r.log);
	assert.deepEqual(r.calls.map(command), ["update", "update", "install", "install", "install", "autoclean"]);
	assert.deepEqual(r.downloaded, [GST_NEW]);
	assert.match(r.log, /LibreOffice install failed \(attempt 2 of 3\)/);
	assert.equal(r.githubOutput, keyOf(r.files));
});

test("when the cache lacks a package and the mirror stays down, it fails naming the package and writes no key", () => {
	const r = run({
		stale: [GST_OLD, WRITER, CALC],
		fresh: [GST_NEW, WRITER, CALC],
		cached: [WRITER, CALC],
		updateFailures: 99,
		fetchFailures: 99,
	});
	assert.equal(r.status, 1, r.log);
	assert.deepEqual(r.calls.map(command), ["update", "update", "update", "install", "install", "install"]);
	assert.match(
		r.log,
		/::error::LibreOffice could not be installed: could not get libgstreamer-plugins-base1\.0-0 from the cache or the mirror\./,
	);
	assert.equal(r.githubOutput, "");
});
