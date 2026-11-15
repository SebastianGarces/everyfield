import { lstat, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { developmentHosts } from "../../packages/db/src/development.ts";
const require = createRequire(new URL("../../packages/domain/package.json", import.meta.url));
const { z } = require("zod");
const operations = z.enum([
	"migration-inspect",
	"migration-apply",
	"migration-adopt",
	"backup-check",
	"restore-rehearsal",
	"backup-copy",
	"readiness",
]);
const control = z.strictObject({
	version: z.literal(1),
	host: z.string(),
	uid: z.number().int(),
	environment: z.literal("development"),
	context: z.enum(["migration-operator", "restricted-backup", "restricted-recovery"]),
	expiresAt: z.iso.datetime(),
	operations: z.array(operations).min(1),
	database: z
		.strictObject({
			host: z.string(),
			name: z.string(),
			role: z.string(),
			schema: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
		})
		.optional(),
});
/** A regular, non-symlink file of the current OS user with no group or other permissions, at most `limit` bytes. */
export async function readPrivateBytes(path, limit = 1024 * 1024) {
	const info = await lstat(path);
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		info.uid !== process.getuid() ||
		(info.mode & 0o077) !== 0 ||
		info.size > limit
	)
		throw Error("unsafe_control_file");
	return readFile(path);
}
export async function readPrivateJson(path) {
	return JSON.parse((await readPrivateBytes(path)).toString("utf8"));
}
export async function loadControl(path, operation) {
	const c = control.parse(await readPrivateJson(path));
	if (
		c.host !== hostname() ||
		c.uid !== process.getuid() ||
		Date.parse(c.expiresAt) <= Date.now() ||
		!c.operations.includes(operation) ||
		process.env.NODE_ENV === "production"
	)
		throw Error("operator_unavailable");
	const context = {
		"backup-check": "restricted-backup",
		"backup-copy": "restricted-backup",
		"restore-rehearsal": "restricted-recovery",
	}[operation];
	if ((context ?? "migration-operator") !== c.context) throw Error("operator_context_mismatch");
	return c;
}
export function developmentConnection(c, raw) {
	const u = new URL(raw);
	if (
		!c.database ||
		!developmentHosts.has(u.hostname) ||
		u.hostname !== c.database.host ||
		decodeURIComponent(u.username) !== c.database.role ||
		decodeURIComponent(u.pathname.slice(1)) !== c.database.name
	)
		throw Error("target_mismatch");
	u.searchParams.set("sslmode", "verify-full");
	return u.href;
}
