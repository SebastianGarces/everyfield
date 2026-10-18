import { sql as querySql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
// Run explicitly with test:identity:production. Owns one managed production preview.
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { fixture, register } from "./support.mts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const percentile = (values: number[], q: number) =>
	[...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]!;

test(
	"AC:WP005-API-RESET existing and missing reset/verification requests share a production latency class despite slow outbox inserts",
	{ timeout: 240000 },
	async () => {
		const privateDir = await mkdtemp(join(tmpdir(), "wp005-timing-"));
		let f: Awaited<ReturnType<typeof fixture>> | undefined, previewId: string | undefined;
		const results: unknown[] = [];
		try {
			f = await fixture();
			await register(f, "production-timing@example.test");
			await f.db.execute(
				querySql`CREATE FUNCTION slow_identity_mail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.5);RETURN NEW;END $$`,
			);
			await f.db.execute(
				querySql`CREATE TRIGGER slow_identity_mail BEFORE INSERT ON mail FOR EACH ROW EXECUTE FUNCTION slow_identity_mail()`,
			);
			const settings = join(privateDir, "settings.json");
			await writeFile(settings, JSON.stringify(f.previewSettings), { mode: 0o600 });
			const setup = join(privateDir, "setup.mjs");
			const slug = basename(root)
				.toLowerCase()
				.replace(/[^a-z0-9-]/g, "-");
			await writeFile(
				setup,
				`import {readFileSync,writeFileSync} from 'node:fs';
const settings=JSON.parse(readFileSync(${JSON.stringify(settings)},'utf8'));
const origin='http://${slug}-'+process.env.PREVIEW_ID.slice(0,8)+'.localhost:1355';
writeFileSync('apps/web/.env.local',Object.entries({...settings,IDENTITY_ORIGIN:origin}).map(([k,v])=>k+'='+JSON.stringify(v)).join('\\n')+'\\n',{mode:0o600});
`,
			);
			const config = join(privateDir, "preview.json");
			const ordinary = JSON.parse(await readFile(join(root, "scripts/preview.json"), "utf8"));
			await writeFile(
				config,
				JSON.stringify({
					...ordinary,
					setup: [process.execPath, setup],
					teardown: [process.execPath, "-e", "require('node:fs').rmSync('apps/web/.env.local',{force:true})"],
					env: { ...ordinary.env, VERCEL: "1", CI: "true", PATH: process.env.PATH },
				}),
				{ mode: 0o600 },
			);
			const out = await exec(
				"portless",
				["preview", "up", "--project", root, "--mode", "production", "--config", config, "--json"],
				{ maxBuffer: 1024 * 1024 },
			);
			const preview = JSON.parse(out.stdout);
			previewId = preview.id;
			const head = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
			assert.equal(preview.head, head);
			assert.equal(preview.mode, "production");
			assert.equal(preview.url, `http://${slug}-${preview.id.slice(0, 8)}.localhost:1355`);
			for (const path of ["request-password-reset", "send-verification-email"]) {
				const rows: Array<{ existing: number; missing: number }> = [];
				for (let i = 0; i < 22; i++) {
					await f.db.execute(querySql`DELETE FROM admission_attempt WHERE kind='reset'`);
					const before = (await f.db.execute(querySql`SELECT count(*)::int n FROM mail`)).rows[0].n;
					const row = { existing: 0, missing: 0 };
					for (const kind of (i % 2 ? ["missing", "existing"] : ["existing", "missing"]) as Array<
						"existing" | "missing"
					>) {
						const start = performance.now();
						const response = await fetch(`${preview.url}/api/auth/${path}`, {
							method: "POST",
							headers: { origin: preview.url, "content-type": "application/json" },
							body: JSON.stringify({
								email: kind === "existing" ? "production-timing@example.test" : `absent-${path}-${i}@example.test`,
							}),
						});
						assert.equal(response.status, 200);
						assert.deepEqual(await response.json(), { status: "accepted" });
						assert.equal(response.headers.getSetCookie().length, 0);
						row[kind] = performance.now() - start;
					}
					// Observe completion outside the measured response. This proves the slow
					// known-address work executed, without measuring its duration as admission.
					const deadline = performance.now() + 15000;
					while ((await f.db.execute(querySql`SELECT count(*)::int n FROM mail`)).rows[0].n === before) {
						assert.ok(performance.now() < deadline, "post-response proof mail must reach the real outbox");
						await new Promise((r) => setTimeout(r, 50));
					}
					assert.equal((await f.db.execute(querySql`SELECT count(*)::int n FROM mail`)).rows[0].n, before + 1);
					if (i >= 2) rows.push(row); // Discard two cold-start/warmup pairs for each route.
				}
				const existing = rows.map((r) => r.existing),
					missing = rows.map((r) => r.missing);
				const medianDifferenceMs = Math.abs(percentile(existing, 0.5) - percentile(missing, 0.5));
				const p90DifferenceMs = Math.abs(percentile(existing, 0.9) - percentile(missing, 0.9));
				const result = {
					path,
					pairs: rows.length,
					injectedMailInsertDelayMs: 1500,
					medianDifferenceMs,
					p90DifferenceMs,
					rows,
				};
				results.push(result);
				console.log(JSON.stringify(result));
				assert.ok(
					medianDifferenceMs <= 150,
					`${path}: median distribution gap ${medianDifferenceMs} ms exceeds 150 ms`,
				);
				assert.ok(p90DifferenceMs <= 250, `${path}: p90 distribution gap ${p90DifferenceMs} ms exceeds 250 ms`);
			}
			if (process.env.IDENTITY_TIMING_REPORT)
				await writeFile(
					resolve(process.env.IDENTITY_TIMING_REPORT),
					JSON.stringify({ head, mode: "production", verdict: "pass", results }, null, 2),
				);
		} finally {
			if (previewId) await exec("portless", ["preview", "down", previewId, "--json"]);
			await f?.close();
			await rm(privateDir, { recursive: true, force: true });
		}
	},
);
