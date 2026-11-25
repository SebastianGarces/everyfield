import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { OperatorRefused, readPrivateBytes } from "./control.mts";
const require = createRequire(new URL("../../packages/db/package.json", import.meta.url));
type Http = { headers?: Record<string, string> };
type Middleware = (
	next: (args: { request: Http }) => Promise<{ response: Http }>,
) => (args: { request: Http }) => Promise<{ response: Http }>;
type Command<Answer> = {
	readonly answer?: Answer;
	middlewareStack: { add(middleware: Middleware, options: { step: string; name: string }): void };
};
type Make<Input, Answer> = new (input: { Bucket: string } & Input) => Command<Answer>;
type Keyed = { Key: string };
type Version = { Key?: string; VersionId?: string; IsLatest?: boolean };
type VersionPage = {
	Versions?: Version[];
	DeleteMarkers?: Version[];
	IsTruncated?: boolean;
	NextKeyMarker?: string;
	NextVersionIdMarker?: string;
};
type Client = { send<Answer>(command: Command<Answer>): Promise<Answer> };
type Sdk = {
	S3Client: new (config: {
		endpoint: string;
		region: string;
		forcePathStyle: boolean;
		credentials: { accessKeyId: string; secretAccessKey: string };
	}) => Client;
	PutObjectCommand: Make<Keyed & { Body: Uint8Array | string; ContentType?: string; IfNoneMatch?: string }, unknown>;
	GetObjectCommand: Make<
		Keyed,
		{ Body?: { transformToByteArray(): Promise<Uint8Array> }; ContentLength?: number; VersionId?: string }
	>;
	DeleteObjectCommand: Make<Keyed, unknown>;
	RestoreObjectCommand: Make<Keyed, unknown>;
	HeadBucketCommand: Make<unknown, unknown>;
	GetBucketVersioningCommand: Make<unknown, { Status?: string }>;
	ListObjectsV2Command: Make<
		{ Prefix?: string; ContinuationToken?: string; MaxKeys?: number },
		{
			Contents?: { Key?: string; Size?: number; LastModified?: Date }[];
			IsTruncated?: boolean;
			NextContinuationToken?: string;
		}
	>;
	ListObjectVersionsCommand: Make<{ KeyMarker?: string; VersionIdMarker?: string }, VersionPage>;
};
export const sdk: Sdk = require("@aws-sdk/client-s3");

export const BACKUP_BUCKET = "everyfield-backup";
const STORE_KEY =
	/^copy\/[0-9-]{10}\/[0-9a-f-]{36}\/(manifest\.json|verified\.json|key|database|objects\/[0-9a-f-]{36})$|^schedule\.json$/;
const COPY_LIMIT = 256 * 1024 * 1024;

export type StoredObject = { key: string; bytes: number; modifiedAt: string };
export type Remain = { key: string; version: string | null; deleted: boolean; latest: boolean };
export type Retention = Record<"versioning" | "snapshots" | "soft_delete", "on" | "off" | "unknown">;

export async function privateEnv(path: string): Promise<Record<string, string>> {
	const text = (await readPrivateBytes(path)).toString("utf8");
	return Object.fromEntries(
		text
			.split("\n")
			.map((line) => /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
			.filter((m) => m !== null)
			.map((m) => [m[1]!, m[2]!.trim().replace(/^(["'])(.*)\1$/, "$2")]),
	);
}

export function objectClient(env: Record<string, string>): Client {
	const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION } = env;
	if (!AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY || !AWS_ENDPOINT_URL_S3)
		throw new OperatorRefused("object_key_invalid");
	const url = new URL(AWS_ENDPOINT_URL_S3);
	if (url.protocol !== "https:" && url.hostname !== "127.0.0.1") throw new OperatorRefused("object_key_invalid");
	return new sdk.S3Client({
		endpoint: AWS_ENDPOINT_URL_S3,
		region: AWS_REGION || "auto",
		forcePathStyle: true,
		credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
	});
}

const named = (error: unknown) => (error instanceof Error ? error.name : "");
const missing = (error: unknown) => ["NoSuchKey", "NotFound"].includes(named(error));

function withHeaders<Answer>(command: Command<Answer>, headers: Record<string, string>) {
	let answered: Record<string, string> = {};
	command.middlewareStack.add(
		(next) => async (args) => {
			Object.assign((args.request.headers ??= {}), headers);
			const answer = await next(args);
			answered = answer.response.headers ?? {};
			return answer;
		},
		{ step: "build", name: "provider-headers" },
	);
	return { command, answered: () => answered };
}

export class BackupBucket {
	readonly #client: Client;
	constructor(client: Client) {
		this.#client = client;
	}
	static async open(credentials: string): Promise<BackupBucket> {
		return new BackupBucket(objectClient(await privateEnv(credentials)));
	}
	#key(key: string) {
		if (!STORE_KEY.test(key)) throw new OperatorRefused("copy_key_invalid");
		return { Bucket: BACKUP_BUCKET, Key: key };
	}
	async put(key: string, bytes: Uint8Array): Promise<void> {
		await this.#client.send(
			new sdk.PutObjectCommand({
				...this.#key(key),
				Body: bytes,
				ContentType: "application/octet-stream",
				IfNoneMatch: "*",
			}),
		);
	}
	async get(key: string): Promise<Uint8Array | null> {
		try {
			const object = await this.#client.send(new sdk.GetObjectCommand(this.#key(key)));
			if (!object.Body || (object.ContentLength ?? 0) > COPY_LIMIT) return null;
			return await object.Body.transformToByteArray();
		} catch (error) {
			if (missing(error)) return null;
			throw error;
		}
	}
	async list(): Promise<StoredObject[]> {
		const found: StoredObject[] = [];
		let token: string | undefined;
		do {
			const page = await this.#client.send(
				new sdk.ListObjectsV2Command({ Bucket: BACKUP_BUCKET, ...(token ? { ContinuationToken: token } : {}) }),
			);
			for (const o of page.Contents ?? [])
				found.push({ key: o.Key!, bytes: o.Size ?? 0, modifiedAt: o.LastModified!.toISOString() });
			token = page.IsTruncated ? page.NextContinuationToken : undefined;
		} while (token);
		return found;
	}
	async delete(key: string): Promise<void> {
		await this.#client.send(new sdk.DeleteObjectCommand(this.#key(key)));
	}
	async retention(): Promise<Retention> {
		const versioning = await this.#client.send(new sdk.GetBucketVersioningCommand({ Bucket: BACKUP_BUCKET }));
		const head = withHeaders(new sdk.HeadBucketCommand({ Bucket: BACKUP_BUCKET }), {});
		await this.#client.send(head.command);
		const restore = withHeaders(new sdk.RestoreObjectCommand(this.#key(`copy/1970-01-01/${randomUUID()}/key`)), {
			"x-tigris-restore-type": "soft-delete",
		});
		const softDelete = await this.#client.send(restore.command).then(
			() => "unknown" as const,
			(error: unknown) =>
				named(error) === "InvalidArgument" ? ("off" as const) : missing(error) ? ("on" as const) : ("unknown" as const),
		);
		const snapshots = head.answered()["x-tigris-enable-snapshot"];
		return {
			versioning: versioning.Status === "Enabled" || versioning.Status === "Suspended" ? "on" : "off",
			snapshots: snapshots === "false" ? "off" : snapshots === "true" ? "on" : "unknown",
			soft_delete: softDelete,
		};
	}
	async remains(): Promise<Remain[]> {
		return [...(await this.#versions({})), ...(await this.#versions({ "x-tigris-soft-delete": "true" }))].filter(
			(v) => v.deleted || !v.latest,
		);
	}
	async #versions(headers: Record<string, string>): Promise<Remain[]> {
		const deleted = "x-tigris-soft-delete" in headers;
		const found: Remain[] = [];
		let marker: { KeyMarker?: string; VersionIdMarker?: string } | null = {};
		while (marker) {
			const page: VersionPage = await this.#client.send(
				withHeaders(new sdk.ListObjectVersionsCommand({ Bucket: BACKUP_BUCKET, ...marker }), headers).command,
			);
			for (const v of page.Versions ?? [])
				found.push({ key: v.Key!, version: v.VersionId ?? null, deleted, latest: v.IsLatest === true });
			for (const v of page.DeleteMarkers ?? [])
				found.push({ key: v.Key!, version: v.VersionId ?? null, deleted: true, latest: false });
			marker = page.IsTruncated
				? {
						...(page.NextKeyMarker ? { KeyMarker: page.NextKeyMarker } : {}),
						...(page.NextVersionIdMarker ? { VersionIdMarker: page.NextVersionIdMarker } : {}),
					}
				: null;
		}
		return found;
	}
}
