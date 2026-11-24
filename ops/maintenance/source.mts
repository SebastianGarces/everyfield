import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { developmentHosts } from "../../packages/db/src/development.ts";
import { DEV_ENDPOINT, NEON_PROJECT, PROD_ENDPOINT, type NeonBranch, type NeonEndpoint } from "../../tools/qa/qa-guard.ts";
import { BACKUP_BUCKET, objectClient, sdk } from "./bucket.mts";

export const DRILL_BRANCH = /^drill-[a-z0-9-]{4,60}$/;
export type SourceClass = "disposable" | "drill" | "development" | "production";
export type ProductionApproval = { host: string; bucket: string; approvedBy: string; approvedAt: string };
export type Neon = { endpoints: NeonEndpoint[]; branches: (NeonBranch & { default?: boolean })[] };

export function readNeon(): Neon {
	const ask = (path: string) =>
		JSON.parse(
			execFileSync("neonctl", ["api", `/projects/${NEON_PROJECT}/${path}`], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				maxBuffer: 16 * 1024 * 1024,
			}),
		);
	return { endpoints: ask("endpoints").endpoints, branches: ask("branches").branches };
}

export function sourceClass(url: URL, neon: () => Neon): SourceClass {
	if (url.hostname === "127.0.0.1")
		return url.pathname === "/everyfield_ci" ? "disposable" : "production";
	if (developmentHosts.has(url.hostname)) return "development";
	const endpoint = url.hostname.split(".")[0]!.replace(/-pooler$/, "");
	if (!url.hostname.endsWith(".aws.neon.tech") || [PROD_ENDPOINT, DEV_ENDPOINT].some((e) => endpoint.startsWith(e)))
		return "production";
	const { endpoints, branches } = neon();
	const branchId = endpoints.find((e) => e.id === endpoint)?.branch_id;
	const branch = branches.find((b) => b.id === branchId);
	if (!branch || branch.default || !DRILL_BRANCH.test(branch.name)) return "production";
	return "drill";
}

export function allowSource(
	url: URL,
	bucket: string,
	approval: ProductionApproval | undefined,
	neon: () => Neon = readNeon,
): SourceClass {
	const found = sourceClass(url, neon);
	const productionBucket = bucket === "everyfield";
	if (bucket === BACKUP_BUCKET) throw Error("source_bucket_refused");
	if (found !== "production" && !productionBucket) return found;
	if (!approval || approval.host !== url.hostname || approval.bucket !== bucket || found !== "production")
		throw Error("production_source_refused");
	return found;
}

export type FileSource = {
	bucket: string;
	read(key: string): Promise<{ bytes: Uint8Array; version: string } | null>;
	keys(prefix: string): Promise<string[]>;
};

export function fileSource(env: Record<string, string>): FileSource {
	const bucket = env.AWS_BUCKET_NAME;
	if (!bucket) throw Error("source_files_invalid");
	const client = objectClient(env);
	return {
		bucket,
		async read(key) {
			try {
				const object = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: key }));
				if (!object.Body) return null;
				const bytes = await object.Body.transformToByteArray();
				return {
					bytes,
					version: object.VersionId ?? `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
				};
			} catch (error) {
				if (error instanceof Error && ["NoSuchKey", "NotFound"].includes(error.name)) return null;
				throw error;
			}
		},
		async keys(prefix) {
			const found: string[] = [];
			let token: string | undefined;
			do {
				const page = await client.send(
					new sdk.ListObjectsV2Command({
						Bucket: bucket,
						Prefix: prefix,
						...(token ? { ContinuationToken: token } : {}),
					}),
				);
				for (const o of page.Contents ?? []) found.push(o.Key!);
				token = page.IsTruncated ? page.NextContinuationToken : undefined;
			} while (token);
			return found;
		},
	};
}
