import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../../ops/maintenance/cli.mts", import.meta.url));
const privateFile = (path: string, text: string) => writeFileSync(path, text, { mode: 0o600 });

export type BackupConfig = {
	context: "migration-operator" | "restricted-backup" | "restricted-recovery";
	operations: string[];
	url: URL;
	schema?: string;
	files: { endpoint: string; bucket: string };
	backups: string;
	production?: { host: string; bucket: string; approvedBy: "owner"; approvedAt: string };
};

export function backupConfig(dir: string, config: BackupConfig): string {
	const { context, operations, url, production } = config;
	mkdirSync(dir, { mode: 0o700 });
	privateFile(
		join(dir, "control.json"),
		JSON.stringify({
			version: 1,
			host: hostname(),
			uid: process.getuid!(),
			environment: "development",
			context,
			expiresAt: "2100-01-01T00:00:00Z",
			operations,
			database: {
				host: url.hostname,
				name: url.pathname.slice(1),
				role: decodeURIComponent(url.username),
				schema: config.schema ?? "public",
			},
			...(production ? { production } : {}),
		}),
	);
	const aws = (endpoint: string) => `AWS_ACCESS_KEY_ID=k\nAWS_SECRET_ACCESS_KEY=s\nAWS_ENDPOINT_URL_S3=${endpoint}\n`;
	privateFile(join(dir, "tigris.env"), aws(config.backups));
	privateFile(
		join(dir, "source.env"),
		`DATABASE_URL_UNPOOLED=${url.href}\n${aws(config.files.endpoint)}AWS_BUCKET_NAME=${config.files.bucket}\n`,
	);
	return dir;
}

export function fakePrograms(dir: string, programs: Record<string, string>): string {
	mkdirSync(dir, { mode: 0o700 });
	for (const [name, output] of Object.entries(programs)) {
		const path = join(dir, name);
		writeFileSync(path, `#!/bin/sh\n/usr/bin/env >> "$0.env"\necho '${output}'\n`);
		chmodSync(path, 0o755);
	}
	return dir;
}

export const runBackupCli = (
	args: string[],
	env: Record<string, string | undefined> = {},
	nodeArgs: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> =>
	new Promise((resolve) =>
		execFile(
			process.execPath,
			["--conditions=react-server", ...nodeArgs, CLI, ...args],
			{ env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
			(error, stdout, stderr) => resolve({ code: error ? Number(error.code) : 0, stdout, stderr }),
		),
	);

export function filesUnder(dir: string): Map<string, Buffer> {
	return new Map(
		readdirSync(dir, { recursive: true, withFileTypes: true })
			.filter((entry) => entry.isFile())
			.map((entry) => join(entry.parentPath, entry.name))
			.map((path) => [path, readFileSync(path)] as const),
	);
}

export function holdsKey(bytes: string | Uint8Array, hex: string): boolean {
	const held = Buffer.from(bytes);
	const raw = Buffer.from(hex, "hex");
	return [
		hex,
		hex.toUpperCase(),
		raw.toString("base64").slice(0, 42),
		raw.toString("base64url").slice(0, 42),
		raw,
	].some((form) => held.includes(form));
}
