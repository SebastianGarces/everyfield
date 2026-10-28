import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { workDbPath } from "./db.ts";
import { EvfError, evfDataDir, run } from "./lib.ts";

/**
 * `evf tui` (OPS-61): the live Rust screen in tools/evf-tui. The crate lives next to this evf, outside the pnpm
 * workspace; the build goes to <git-common-dir>/evf/cargo-target and the binary to <git-common-dir>/evf/bin, so a
 * worktree never gains untracked files. The binary is rebuilt when it is missing or older than the crate sources, and
 * it only ever receives --db, the shared work store path, so the TUI never derives that path itself.
 */

export type TuiPlan = {
	db: string;
	crate: string;
	binary: string;
	targetDir: string;
	build: { needed: boolean; reason: string };
	cargo: string[];
};

/** The crate ships with the evf that runs, so a worktree's evf builds that worktree's crate. */
export const crateDir = (): string => resolve(import.meta.dirname, "../evf-tui");

function newestMtime(path: string): number {
	const s = statSync(path);
	if (!s.isDirectory()) return s.mtimeMs;
	let newest = 0;
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name === "target") continue;
		newest = Math.max(newest, newestMtime(join(path, entry.name)));
	}
	return newest;
}

export function buildNeeded(crate: string, binary: string): { needed: boolean; reason: string } {
	if (!existsSync(binary)) return { needed: true, reason: "binary missing" };
	const sources = ["Cargo.toml", "Cargo.lock", "src"].map((p) => join(crate, p)).filter(existsSync);
	const newest = Math.max(...sources.map(newestMtime));
	if (newest > statSync(binary).mtimeMs) return { needed: true, reason: "sources newer than the binary" };
	return { needed: false, reason: "binary newer than every source" };
}

export function tuiPlan(root: string, crate = crateDir()): TuiPlan {
	if (!existsSync(join(crate, "Cargo.toml"))) throw new EvfError(`The TUI crate is missing at ${crate}.`);
	const data = evfDataDir(root);
	const targetDir = join(data, "cargo-target");
	const binary = join(data, "bin", "evf-tui");
	return {
		db: workDbPath(root),
		crate,
		binary,
		targetDir,
		build: buildNeeded(crate, binary),
		cargo: ["build", "--release", "--locked", "--manifest-path", join(crate, "Cargo.toml"), "--target-dir", targetDir],
	};
}

/** cargo on PATH first, then rustup's default location. */
export function cargoBinary(): string {
	if (run("cargo", ["--version"]).code === 0) return "cargo";
	const rustup = join(homedir(), ".cargo", "bin", "cargo");
	if (existsSync(rustup)) return rustup;
	throw new EvfError("cargo is not installed. Install Rust with rustup (https://rustup.rs), then run evf tui again.");
}

export function tui(root: string, opts: { dryRun: boolean; once: boolean }): number {
	const plan = tuiPlan(root);
	if (opts.dryRun) {
		console.log(`db: ${plan.db}`);
		console.log(`crate: ${plan.crate}`);
		console.log(`binary: ${plan.binary}`);
		console.log(`build: ${plan.build.needed ? `needed (${plan.build.reason})` : `current (${plan.build.reason})`}`);
		console.log(`cargo: cargo ${plan.cargo.join(" ")}`);
		return 0;
	}
	if (plan.build.needed) {
		const cargo = cargoBinary();
		console.error(`evf tui: building tools/evf-tui (${plan.build.reason})…`);
		const built = run(cargo, plan.cargo, { inherit: true });
		if (built.code !== 0) throw new EvfError(`cargo build failed (exit ${built.code}).`);
		mkdirSync(join(plan.binary, ".."), { recursive: true });
		copyFileSync(join(plan.targetDir, "release", "evf-tui"), plan.binary);
		chmodSync(plan.binary, 0o755);
	}
	return run(plan.binary, ["--db", plan.db, ...(opts.once ? ["--once"] : [])], { inherit: true }).code;
}
