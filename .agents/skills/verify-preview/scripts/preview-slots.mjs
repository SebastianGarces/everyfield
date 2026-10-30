// One slot check for every script that starts a portless preview (`evf stack up` and the verify-preview skill's preview.mjs). Portless allows PORTLESS_PREVIEW_LIMIT live previews (D74 keeps it at 4). Before `portless preview up`,
// ensurePreviewSlot releases previews nobody needs, then waits for a free slot instead of failing the seat.
//
// It releases only orphans: previews portless reports as expired or failed, previews whose project path is gone, and
// previews of a task worktree whose task row is merged, done or abandoned with no open run and no live drive. It never
// stops the main checkout's preview, a review preview, or any task that is still working.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_LIMIT = 4;
export const DEFAULT_WAIT_MS = 20 * 60_000;
const DEAD_STATES = new Set(["removed", "failed", "expired"]);
const FINISHED_TASK = new Set(["merged", "done", "abandoned"]);

const portless = (args) => {
  const r = spawnSync("portless", ["preview", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new Error("Cannot run managed Portless. Run portless preview --help to check installation.");
  return r;
};

/** Every preview record portless knows, including removed ones. */
export function previewRecords() {
  const r = portless(["status", "--json"]);
  if (r.status !== 0) throw new Error(`portless preview status failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
  const records = JSON.parse(r.stdout);
  if (!Array.isArray(records)) throw new Error("Portless status must return an array.");
  return records;
}
export const isLive = (preview) => !DEAD_STATES.has(preview.state);

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** The task store and drive pid files of the checkout family, or null when this checkout has no store yet. */
// node:sqlite loads only when a full pool or a wait needs the store: it prints an experimental-feature warning.
async function openStore(common, readOnly = true) {
  const file = join(common, "evf", "work.sqlite");
  if (!existsSync(file)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(file, { readOnly });
  } catch {
    return null;
  }
}

/**
 * Why a live preview is an orphan nobody needs, or null when it must stay. `root` is the main checkout, `common` the
 * shared Git directory.
 */
export function orphanReason(preview, { root, common, store }) {
  const project = preview.project;
  if (!existsSync(project)) return `its project ${project} no longer exists`;
  const dir = dirname(project);
  if (resolve(project) === resolve(root) || dir !== join(root, ".worktrees")) return null;
  // A task worktree is `<slug>`; a prototype idea worktree is `<slug>-ideaN` and belongs to the same task.
  const slug = basename(project).replace(/-idea\d$/, "");
  if (!store) return null;
  const rows = store.prepare("SELECT id, status FROM tasks WHERE slug = ? ORDER BY id DESC").all(slug);
  if (!rows.length || !FINISHED_TASK.has(rows[0].status)) return null;
  const open = store
    .prepare("SELECT COUNT(*) AS n FROM runs r JOIN tasks t ON t.id = r.task_id WHERE t.slug = ? AND r.status = 'started'")
    .get(slug);
  if (open.n > 0) return null;
  const pidFile = join(common, "evf", "drive", `${slug}.pid`);
  if (existsSync(pidFile) && alive(Number(readFileSync(pidFile, "utf8").trim()))) return null;
  return `task ${slug} is ${rows[0].status} with no open run`;
}

/** Release the orphans among `records`. Returns what was released, for the log. */
function releaseOrphans(records, context, log, once) {
  const released = [];
  if (!once.gc && records.some((p) => p.state === "failed" || p.state === "expired")) {
    once.gc = true;
    const gc = portless(["gc", "--apply"]);
    if (gc.status === 0) released.push("expired and failed previews (portless preview gc)");
  }
  for (const preview of records.filter(isLive)) {
    const reason = orphanReason(preview, context);
    if (!reason) continue;
    if (portless(["down", preview.id]).status === 0) released.push(`${preview.project}: ${reason}`);
  }
  if (released.length) log(`released previews nobody needs: ${released.join("; ")}`);
  return released;
}

/** Record the wait as an event of the seat's run, so the TUI and the drive log show it. Never fails the preview. */
async function recordWaitEvent(common, message, env = process.env) {
  const run = Number(env.EVF_RUN);
  if (!Number.isInteger(run) || run <= 0) return;
  try {
    const db = await openStore(common, false);
    if (!db) return;
    db.exec("PRAGMA busy_timeout = 5000");
    const row = db.prepare("SELECT task_id FROM runs WHERE id = ?").get(run);
    if (row)
      db.prepare("INSERT INTO events (task_id, run_id, ts, type, payload) VALUES (?, ?, ?, 'preview_wait', ?)").run(
        row.task_id,
        run,
        new Date().toISOString(),
        JSON.stringify({ summary: message }),
      );
    db.close();
  } catch {
    // The wait itself matters more than its log line.
  }
}

const formatWait = (ms) => (ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const numberFrom = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

/**
 * Wait until `project` may start a preview. A project that already has a live preview reuses it and never waits.
 * Options override the environment: limit (PORTLESS_PREVIEW_LIMIT), waitMs (EVF_PREVIEW_WAIT_MS), pollMs
 * (EVF_PREVIEW_POLL_MS) and announceMs (EVF_PREVIEW_ANNOUNCE_MS, once a minute by default).
 */
export async function ensurePreviewSlot({ project, root, common, ...opts }) {
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
    const store = await openStore(common);
    try {
      releaseOrphans(records, { root, common, store }, log, once);
    } finally {
      store?.close();
    }
    records = previewRecords();
    live = records.filter(isLive);
    if (live.length < limit) return { reused: false, inUse: live.length, limit };
    // Say so before anything else, so even a short bound on a loaded machine prints the status once.
    if (Date.now() - announcedAt >= announceMs) {
      announcedAt = Date.now();
      const message = `waiting for a preview slot (${live.length}/${limit} in use)`;
      log(message);
      await recordWaitEvent(common, message, env);
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
    const project = realpathSync(resolve(at === -1 ? (process.env.EVF_WORKTREE ?? process.cwd()) : args[at + 1]));
    const common = spawnSync("git", ["-C", project, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
    }).stdout.trim();
    await ensurePreviewSlot({ project, root: dirname(common), common });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
