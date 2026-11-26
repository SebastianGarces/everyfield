import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKUP_BUCKET, BackupBucket, objectClient } from "../../ops/maintenance/bucket.mts";

type Stored = { bytes: Buffer; modifiedAt: Date; type?: string };
type Put = (key: string, bytes: Buffer) => Buffer | "refuse";

export async function fakeBucket(name = BACKUP_BUCKET) {
	const objects = new Map<string, Stored>();
	const deleted: string[] = [];
	const settings = {
		now: new Date(0),
		softDelete: false,
		snapshots: false,
		versioning: false,
		put: ((_key, bytes) => bytes) as Put,
		admits: (_accessKey: string | undefined): boolean => true,
	};
	const xml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>${body}`;
	let requests = 0;
	const server = createServer((request, response) => {
		requests++;
		const url = new URL(request.url ?? "/", "http://bucket");
		const [, bucket, ...rest] = decodeURIComponent(url.pathname).split("/");
		const key = rest.join("/");
		const answer = (status: number, body?: string | Buffer) => {
			response.statusCode = status;
			if (typeof body === "string") response.setHeader("content-type", "application/xml");
			response.end(request.method === "HEAD" ? undefined : body);
		};
		const fail = (status: number, code: string) => answer(status, xml(`<Error><Code>${code}</Code></Error>`));
		const accessKey = /Credential=([^/]+)\//.exec(request.headers.authorization ?? "")?.[1];
		if (bucket !== name || !settings.admits(accessKey)) return fail(403, "AccessDenied");
		const signedAt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(url.searchParams.get("X-Amz-Date") ?? "");
		const lifetime = Number(url.searchParams.get("X-Amz-Expires"));
		if (signedAt && lifetime) {
			const [, y, mo, d, h, mi, se] = signedAt;
			const issued = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${se}Z`);
			if (settings.now.getTime() > issued + lifetime * 1000) return fail(403, "AccessDenied");
		}
		if (!key) {
			if (request.method === "HEAD") {
				response.setHeader("x-tigris-enable-snapshot", String(settings.snapshots));
				return answer(200);
			}
			if (url.searchParams.has("versioning"))
				return answer(
					200,
					xml(
						`<VersioningConfiguration>${settings.versioning ? "<Status>Enabled</Status>" : ""}</VersioningConfiguration>`,
					),
				);
			if (url.searchParams.has("versions")) {
				const keys =
					request.headers["x-tigris-soft-delete"] === "true"
						? settings.softDelete
							? deleted
							: []
						: [...objects.keys()];
				const latest = request.headers["x-tigris-soft-delete"] !== "true";
				return answer(
					200,
					xml(
						`<ListVersionsResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Version><Key>${k}</Key><VersionId>1</VersionId><IsLatest>${latest}</IsLatest></Version>`).join("")}</ListVersionsResult>`,
					),
				);
			}
			if (url.searchParams.has("acl"))
				return answer(
					200,
					xml(
						`<AccessControlPolicy><Owner><ID>owner</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>owner</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>`,
					),
				);
			return answer(
				200,
				xml(
					`<ListBucketResult><IsTruncated>false</IsTruncated>${[...objects].map(([k, o]) => `<Contents><Key>${k}</Key><Size>${o.bytes.length}</Size><LastModified>${o.modifiedAt.toISOString()}</LastModified></Contents>`).join("")}</ListBucketResult>`,
				),
			);
		}
		if (request.method === "POST") return settings.softDelete ? fail(404, "NoSuchKey") : fail(400, "InvalidArgument");
		if (request.method === "DELETE") {
			if (objects.delete(key)) deleted.push(key);
			return answer(204);
		}
		if (request.method === "PUT") {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				if (request.headers["if-none-match"] === "*" && objects.has(key)) return fail(412, "PreconditionFailed");
				const kept = settings.put(key, Buffer.concat(chunks));
				if (kept === "refuse") return fail(400, "InvalidRequest");
				objects.set(key, { bytes: kept, modifiedAt: settings.now, type: request.headers["content-type"] });
				answer(200);
			});
			return;
		}
		const found = objects.get(key);
		if (!found) return fail(404, "NoSuchKey");
		response.setHeader("content-length", found.bytes.length);
		response.setHeader("content-type", found.type ?? "application/octet-stream");
		answer(200, found.bytes);
	});
	await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
	const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const bucket = new BackupBucket(
		objectClient({ AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s", AWS_ENDPOINT_URL_S3: endpoint }),
	);
	return {
		bucket,
		endpoint,
		objects,
		settings,
		requests: () => requests,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	};
}
