import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../scripts/stack.mjs", import.meta.url));

// Fake only the external Portless executable. The public CLI and filesystem are real.
const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const file = process.env.FAKE_REGISTRY;
const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
let result;
if (args[1] === 'status') result = rows;
else if (args[1] === 'up') {
  const project = args[args.indexOf('--project') + 1];
  result = rows.find(p => p.project === project && p.state === 'ready');
  if (!result) {
    const id = String(rows.length + 1);
    result = {id, project, head: 'abc', branch: 'task/example', mode: args[args.indexOf('--mode') + 1], state: 'ready', url: 'http://p' + id + '.localhost:1355'};
    // Like Portless: the PREVIEW_URL placeholder in the config env becomes this preview's own URL. Record the resolved env.
    const config = args[args.indexOf('--config') + 1];
    const env = fs.existsSync(config) ? JSON.parse(fs.readFileSync(config, 'utf8')).env ?? {} : {};
    const resolved = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v).replaceAll('\${PREVIEW_URL}', result.url)]));
    fs.writeFileSync(path.join(path.dirname(file), 'env-' + id + '.json'), JSON.stringify(resolved));
    rows.push(result);
  }
} else if (args[1] === 'down') {
  result = rows.find(p => p.id === args[2]);
  if (!result) process.exit(2);
  result.state = 'removed';
} else process.exit(2);
fs.writeFileSync(file, JSON.stringify(rows));
console.log(JSON.stringify(result));
`;

test("INV-workflow: repeated starts and stops stay confined to the selected worktree", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "evf-stack-test-")));
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "portless"), fake);
		chmodSync(join(bin, "portless"), 0o755);
		const a = join(dir, "a");
		const b = join(dir, "b");
		mkdirSync(a);
		mkdirSync(b);
		const runtime = join(dir, "runtime");
		const env = {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FAKE_REGISTRY: join(dir, "registry.json"),
			EVF_RUNTIME_DIR: runtime,
		};
		function command(action, project, ...extra) {
			return spawnSync(process.execPath, [script, action, "--project", project, ...extra], { env, encoding: "utf8" });
		}
		function ok(action, project, ...extra) {
			const r = command(action, project, ...extra);
			assert.equal(r.status, 0, r.stderr);
			return JSON.parse(r.stdout);
		}
		assert.equal(ok("up", a).id, "1");
		assert.equal(ok("up", a).id, "1");
		assert.equal(ok("up", b).id, "2");
		assert.equal(ok("status", a).id, "1");
		assert.equal(command("up", a, "--mode", "production").status, 1);
		assert.equal(ok("down", a).state, "stopped");
		assert.deepEqual(ok("status", b), {
			id: "2",
			project: b,
			head: "abc",
			branch: "task/example",
			mode: "development",
			state: "ready",
			url: "http://p2.localhost:1355",
		});
		assert.equal(JSON.parse(readFileSync(join(runtime, "stack.json"), "utf8")).id, "2");
		assert.equal(ok("down", a).state, "stopped");
		assert.equal(ok("down", b).state, "stopped");
		assert.deepEqual(
			JSON.parse(readFileSync(env.FAKE_REGISTRY, "utf8")).map((p) => [p.id, p.state]),
			[
				["1", "removed"],
				["2", "removed"],
			],
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("OPS-76: each preview resolves IDENTITY_ORIGIN to its own URL, whatever its id, mode or stale env file", () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "evf-stack-origin-")));
	try {
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(join(bin, "portless"), fake);
		chmodSync(join(bin, "portless"), 0o755);
		const env = {
			...process.env,
			PATH: `${bin}:${process.env.PATH}`,
			FAKE_REGISTRY: join(dir, "registry.json"),
			EVF_RUNTIME_DIR: join(dir, "runtime"),
		};
		const realConfig = fileURLToPath(new URL("../../scripts/preview.json", import.meta.url));
		const stale = "IDENTITY_ORIGIN=https://stale.localhost\n";
		let staleFile = "";
		const urls = new Set();
		for (const mode of ["development", "production"]) {
			for (const name of ["one", "two"]) {
				const project = join(dir, `${mode}-${name}`);
				mkdirSync(join(project, "scripts"), { recursive: true });
				copyFileSync(realConfig, join(project, "scripts/preview.json"));
				if (mode === "development" && name === "one") {
					mkdirSync(join(project, "apps/web"), { recursive: true });
					staleFile = join(project, "apps/web/.env.local");
					writeFileSync(staleFile, stale);
				}
				const r = spawnSync(process.execPath, [script, "up", "--project", project, "--mode", mode], {
					env,
					encoding: "utf8",
				});
				assert.equal(r.status, 0, r.stderr);
				const preview = JSON.parse(r.stdout);
				const resolved = JSON.parse(readFileSync(join(dir, `env-${preview.id}.json`), "utf8"));
				assert.equal(resolved.IDENTITY_ORIGIN, preview.url, `${mode} ${name}`);
				assert.equal(resolved.NEXT_TELEMETRY_DISABLED, "1");
				urls.add(preview.url);
			}
		}
		assert.equal(urls.size, 4);
		assert.equal(readFileSync(staleFile, "utf8"), stale);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
