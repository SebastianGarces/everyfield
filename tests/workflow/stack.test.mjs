import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../../scripts/stack.mjs", import.meta.url));

// Fake only the external Portless executable. The public CLI and filesystem are real.
const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const file = process.env.FAKE_REGISTRY;
const rows = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
let result;
if (args[1] === 'status') result = rows;
else if (args[1] === 'up') {
  const project = args[args.indexOf('--project') + 1];
  result = rows.find(p => p.project === project && p.state === 'ready');
  if (!result) {
    result = {id: String(rows.length + 1), project, head: 'abc', branch: 'task/example', mode: args[args.indexOf('--mode') + 1], state: 'ready', url: 'http://example.localhost:1355'};
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
    const bin = join(dir, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "portless"), fake); chmodSync(join(bin, "portless"), 0o755);
    const a = join(dir, "a"); const b = join(dir, "b"); mkdirSync(a); mkdirSync(b);
    const runtime = join(dir, "runtime");
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_REGISTRY: join(dir, "registry.json"), EVF_RUNTIME_DIR: runtime };
    function command(action, project, ...extra) {
      return spawnSync(process.execPath, [script, action, "--project", project, ...extra], { env, encoding: "utf8" });
    }
    function ok(action, project, ...extra) {
      const r = command(action, project, ...extra); assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
    }
    assert.equal(ok("up", a).id, "1");
    assert.equal(ok("up", a).id, "1");
    assert.equal(ok("up", b).id, "2");
    assert.equal(ok("status", a).id, "1");
    assert.equal(command("up", a, "--mode", "production").status, 1);
    assert.equal(ok("down", a).state, "stopped");
    assert.deepEqual(ok("status", b), { id: "2", project: b, head: "abc", branch: "task/example", mode: "development", state: "ready", url: "http://example.localhost:1355" });
    assert.equal(JSON.parse(readFileSync(join(runtime, "stack.json"), "utf8")).id, "2");
    assert.equal(ok("down", a).state, "stopped");
    assert.equal(ok("down", b).state, "stopped");
    assert.deepEqual(JSON.parse(readFileSync(env.FAKE_REGISTRY, "utf8")).map(p => [p.id, p.state]), [["1", "removed"], ["2", "removed"]]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
