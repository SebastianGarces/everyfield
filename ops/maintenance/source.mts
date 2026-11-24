import { execFileSync } from "node:child_process";
import { OperatorRefused } from "./control.mts";
import { createHash } from "node:crypto";
import { developmentHosts } from "../../packages/db/src/development.ts";
import {
	DEV_ENDPOINT,
	NEON_PROJECT,
	PROD_ENDPOINT,
	type NeonBranch,
	type NeonEndpoint,
} from "../../tools/qa/qa-guard.ts";
import { BACKUP_BUCKET, objectClient, sdk } from "./bucket.mts";

export const DRILL_BRANCH = /^drill-[a-z0-9-]{4,60}$/;
export type SourceClass = "disposable" | "drill" | "development" | "production";
export type ProductionApproval = { host: string; bucket: string; approvedBy: string; approvedAt: string };
type Branch = NeonBranch & { default?: boolean; parent_id?: string | null; parent_timestamp?: string | null };
export type Neon = { endpoints: NeonEndpoint[]; branches: Branch[] };

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
	if (url.hostname === "127.0.0.1") return url.pathname === "/everyfield_ci" ? "disposable" : "production";
	if (developmentHosts.has(url.hostname)) return "development";
	return drillBranch(url, neon) ? "drill" : "production";
}

const endpointOf = (url: URL) => url.hostname.split(".")[0]!.replace(/-pooler$/, "");

function drillBranch(url: URL, neon: () => Neon): Branch | null {
	const endpoint = endpointOf(url);
	if (!url.hostname.endsWith(".aws.neon.tech") || [PROD_ENDPOINT, DEV_ENDPOINT].some((e) => endpoint.startsWith(e)))
		return null;
	const { endpoints, branches } = neon();
	const at = (id: string | null | undefined) => branches.find((b) => b.id === id);
	const named = at(endpoints.find((e) => e.id === endpoint)?.branch_id);
	const development = endpoints.find((e) => e.id.startsWith(DEV_ENDPOINT))?.branch_id;
	let root = named;
	for (let hops = 0; root && !root.default && DRILL_BRANCH.test(root.name) && hops < 10; hops++)
		root = at(root.parent_id);
	if (!named || named === root || !root || root.default || root.id !== development) return null;
	return named;
}

export function historyPoint(url: URL, neon: () => Neon = readNeon): string {
	const at = drillBranch(url, neon)?.parent_timestamp;
	if (!at) throw new OperatorRefused("recovery_point_unknown");
	return new Date(at).toISOString();
}

export function allowSource(
	url: URL,
	bucket: string,
	approval: ProductionApproval | undefined,
	neon: () => Neon = readNeon,
): SourceClass {
	const found = sourceClass(url, neon);
	const productionBucket = bucket === "everyfield";
	if (bucket === BACKUP_BUCKET) throw new OperatorRefused("source_bucket_refused");
	if (found !== "production" && !productionBucket) return found;
	if (!approval || approval.host !== url.hostname || approval.bucket !== bucket || found !== "production")
		throw new OperatorRefused("production_source_refused");
	return found;
}

export type FileSource = {
	bucket: string;
	read(key: string): Promise<{ bytes: Uint8Array; version: string } | null>;
	keys(prefix: string): Promise<string[]>;
};

export function fileSource(env: Record<string, string>): FileSource {
	const bucket = env.AWS_BUCKET_NAME;
	if (!bucket) throw new OperatorRefused("source_files_invalid");
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
