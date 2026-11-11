// One slot check for every script that starts a portless preview (`bin/dev stack up` and the verify-preview skill's preview.mjs). Portless allows PORTLESS_PREVIEW_LIMIT live previews (D74 keeps it at 4). Before `portless preview up`,
// ensurePreviewSlot releases previews nobody needs, then waits for a free slot instead of failing the seat.
//
// It releases only orphans: previews portless reports as expired or failed, and previews whose project path is gone. It
// never stops a preview whose project still exists, so it cannot stop a task that is still working.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_LIMIT = 4;
const DEFAULT_WAIT_MS = 20 * 60_000;
const DEAD_STATES = new Set(["removed", "failed", "expired"]);

const portless = (args) => {
  const r = spawnSync("portless", ["preview", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error("Cannot run managed Portless. Run portless preview --help to check installation.");
  return r;
};

/** Every preview record portless knows, including removed ones. */
function previewRecords() {
  const r = portless(["status", "--json"]);
  if (r.status !== 0) throw new Error(`portless preview status failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  const records = JSON.parse(r.stdout);
  if (!Array.isArray(records)) throw new Error("Portless status must return an array.");
  return records;
}
const isLive = (preview) => !DEAD_STATES.has(preview.state);

/** Release the orphans among `records`. Returns what was released, for the log. */
function releaseOrphans(records, log, once) {
  const released = [];
  if (!once.gc && records.some((p) => p.state === "failed" || p.state === "expired")) {
    once.gc = true;
    const gc = portless(["gc", "--apply"]);
    if (gc.status === 0) released.push("expired and failed previews (portless preview gc)");
  }
  for (const preview of records.filter(isLive)) {
    if (existsSync(preview.project)) continue;
    if (portless(["down", preview.id]).status === 0) released.push(`${preview.project}: its project no longer exists`);
  }
  if (released.length) log(`released previews nobody needs: ${released.join("; ")}`);
  return released;
}

const formatWait = (ms) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const numberFrom = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

/**
 * Wait until `project` may start a preview. A project that already has a live preview reuses it and never waits.
 * Options override the environment: limit (PORTLESS_PREVIEW_LIMIT), waitMs (EVF_PREVIEW_WAIT_MS), pollMs
 * (EVF_PREVIEW_POLL_MS) and announceMs (EVF_PREVIEW_ANNOUNCE_MS, once a minute by default).
 */
export async function ensurePreviewSlot({ project, ...opts }) {
  const env = opts.env ?? process.env;
  const limit = opts.limit ?? numberFrom(env.PORTLESS_PREVIEW_LIMIT, DEFAULT_LIMIT);
  const waitMs = opts.waitMs ?? numberFrom(env.EVF_PREVIEW_WAIT_MS, DEFAULT_WAIT_MS);
  const pollMs = opts.pollMs ?? numberFrom(env.EVF_PREVIEW_POLL_MS, 15_000);
  const announceMs = opts.announceMs ?? numberFrom(env.EVF_PREVIEW_ANNOUNCE_MS, 60_000);
  const log = opts.log ?? ((line) => console.error(`preview slots: ${line}`));
  const started = Date.now();
  const once = { gc: false };
  let announcedAt = -Infinity,
    live = [];
  for (;;) {
    let records = previewRecords();
    const own = records.find((p) => p.project === project && isLive(p));
    if (own) return { reused: true, preview: own };
    live = records.filter(isLive);
    if (live.length < limit) return { reused: false, inUse: live.length, limit };
    // The pool is full: free what nobody needs before anyone waits.
    releaseOrphans(records, log, once);
    records = previewRecords();
    live = records.filter(isLive);
    if (live.length < limit) return { reused: false, inUse: live.length, limit };
    // Say so before anything else, so even a short bound on a loaded machine prints the status once.
    if (Date.now() - announcedAt >= announceMs) {
      announcedAt = Date.now();
      log(`waiting for a preview slot (${live.length}/${limit} in use)`);
    }
    const waited = Date.now() - started;
    if (waited >= waitMs)
      throw new Error(
        `No free preview slot after waiting ${formatWait(waited)}: ${live.length}/${limit} previews in use (PORTLESS_PREVIEW_LIMIT ${limit}). Held by: ${live.map((p) => `${p.project} (${p.state})`).join(", ")}. Try again when one finishes.`,
      );
    await sleep(Math.min(pollMs, waitMs - waited));
  }
}

// Command line: `node preview-slots.mjs [--project PATH]` waits for a slot. Exit 1 with the message when the wait runs out.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--project");
  try {
    const project = realpathSync(resolve(at === -1 ? process.cwd() : args[at + 1]));
    await ensurePreviewSlot({ project });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
