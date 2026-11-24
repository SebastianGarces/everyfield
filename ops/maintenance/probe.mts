import { randomUUID } from "node:crypto";
import { BACKUP_BUCKET, objectClient, privateEnv, sdk } from "./bucket.mts";

export type ProbeAnswer = "allowed" | "refused" | "unknown";
export type KeyProbe = Record<"list" | "read" | "write" | "delete", ProbeAnswer>;
export const APP_KEYS = ["production", "preview", "development"] as const;
const OTHER_BUCKETS = ["everyfield", "everyfield-dev", "everyfield-preview"];

const ask = (request: Promise<unknown>): Promise<ProbeAnswer> =>
	request.then(
		() => "allowed" as const,
		(error: unknown) => {
			const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
			const name = error instanceof Error ? error.name : "";
			if (status === 401 || status === 403) return "refused";
			return name === "NoSuchKey" || name === "NotFound" ? "allowed" : "unknown";
		},
	);

export async function probeBackupBucket(env: Record<string, string>): Promise<KeyProbe> {
	const client = objectClient(env);
	const at = { Bucket: BACKUP_BUCKET, Key: `probe/${randomUUID()}` };
	const list = await ask(client.send(new sdk.ListObjectsV2Command({ Bucket: BACKUP_BUCKET, MaxKeys: 1 })));
	const read = await ask(client.send(new sdk.GetObjectCommand(at)));
	const write = await ask(client.send(new sdk.PutObjectCommand({ ...at, Body: "probe", IfNoneMatch: "*" })));
	const remove = await ask(client.send(new sdk.DeleteObjectCommand(at)));
	return { list, read, write, delete: remove };
}

export async function probeOtherBuckets(env: Record<string, string>) {
	const client = objectClient(env);
	const answers: Record<string, Pick<KeyProbe, "list" | "read">> = {};
	for (const bucket of OTHER_BUCKETS)
		answers[bucket] = {
			list: await ask(client.send(new sdk.ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }))),
			read: await ask(client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: `probe/${randomUUID()}` }))),
		};
	return answers;
}

export async function probeAppKeys(files: readonly string[]) {
	const keys: Record<string, KeyProbe> = {};
	for (const entry of files) {
		const at = entry.indexOf("=");
		const name = entry.slice(0, at);
		if (!(APP_KEYS as readonly string[]).includes(name)) throw Error("probe_key_unknown");
		keys[name] = await probeBackupBucket(await privateEnv(entry.slice(at + 1)));
	}
	return { keys, restricted: keysRestricted(keys) };
}

export function keysRestricted(keys: unknown): boolean {
	const known = keys && typeof keys === "object" ? (keys as Record<string, Partial<KeyProbe>>) : {};
	return APP_KEYS.every((name) =>
		(["list", "read", "write", "delete"] as const).every((op) => known[name]?.[op] === "refused"),
	);
}
