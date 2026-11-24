import { lstat, readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { createRequire } from "node:module";
import { developmentHosts } from "../../packages/db/src/development.ts";
const require = createRequire(new URL("../../packages/domain/package.json", import.meta.url));
const { z }: typeof import("../../packages/domain/node_modules/zod/index.js") = require("zod");
export type ControlDatabase = NonNullable<Control["database"]>;
const operations = z.enum([
	"migration-inspect",
	"migration-apply",
	"migration-adopt",
	"backup-check",
	"restore-rehearsal",
	"backup-copy",
	"readiness",
	"backup-key-create",
	"backup-capture",
	"backup-daily",
	"backup-expire",
	"backup-status",
	"bucket-probe",
	"schedule-install",
	"schedule-uninstall",
	"restore-copy",
	"restore-open",
	"deletion-check",
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
	production: z
		.strictObject({
			host: z.string().min(1),
			bucket: z.string().min(1),
			approvedBy: z.literal("owner"),
			approvedAt: z.iso.datetime(),
		})
		.optional(),
});
export type Control = ReturnType<typeof control.parse>;
export async function readPrivateBytes(path: string, limit = 1024 * 1024) {
	const info = await lstat(path);
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		info.uid !== process.getuid!() ||
		(info.mode & 0o077) !== 0 ||
		info.size > limit
	)
		throw Error("unsafe_control_file");
	return readFile(path);
}
export async function readPrivateJson(path: string) {
	return JSON.parse((await readPrivateBytes(path)).toString("utf8"));
}
export async function loadControl(path: string, operation: string) {
	const c = control.parse(await readPrivateJson(path));
	if (
		c.host !== hostname() ||
		c.uid !== process.getuid!() ||
		Date.parse(c.expiresAt) <= Date.now() ||
		!(c.operations as readonly string[]).includes(operation) ||
		process.env.NODE_ENV === "production"
	)
		throw Error("operator_unavailable");
	const context = /^(backup-|bucket-|schedule-)/.test(operation)
		? "restricted-backup"
		: /^(restore-|deletion-)/.test(operation)
			? "restricted-recovery"
			: "migration-operator";
	if (context !== c.context) throw Error("operator_context_mismatch");
	return c;
}
export function pinnedConnection(c: Control, raw: string): { url: URL; href: string; database: ControlDatabase } {
	const url = new URL(raw);
	const d = c.database;
	if (
		!d ||
		url.hostname !== d.host ||
		decodeURIComponent(url.username) !== d.role ||
		decodeURIComponent(url.pathname.slice(1)) !== d.name
	)
		throw Error("target_mismatch");
	if (url.hostname !== "127.0.0.1") url.searchParams.set("sslmode", "verify-full");
	return { url, href: url.href, database: d };
}
export function developmentConnection(c: Control, raw: string) {
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
