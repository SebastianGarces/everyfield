import { S3Client, type PrivateStorage } from "../../../packages/db/src/schema/storage.ts";

export function bucket() {
	const objects = new Map<string, Buffer>();
	const deleted: string[] = [];
	const client = new S3Client({
		endpoint: "http://127.0.0.1:9",
		region: "auto",
		forcePathStyle: true,
		credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
	});
	client.send = (async (command: { constructor: { name: string }; input: { Key?: string } }) => {
		const name = command.constructor.name;
		if (name === "GetBucketAclCommand")
			return { Grants: [{ Grantee: { Type: "CanonicalUser", ID: "owner" }, Permission: "FULL_CONTROL" }] };
		const key = command.input.Key!;
		if (name === "DeleteObjectCommand") return (deleted.push(key), objects.delete(key), {});
		if (name === "PutObjectCommand")
			return (objects.set(key, Buffer.from((command.input as { Body: Uint8Array }).Body)), {});
		if (name !== "GetObjectCommand") throw Error("unexpected provider operation " + name);
		const body = objects.get(key);
		if (!body) throw Error("NoSuchKey");
		return {
			ContentLength: body.length,
			ContentType: "text/csv",
			Body: { transformToByteArray: async () => new Uint8Array(body) },
		};
	}) as never;
	return { storage: { bucket: "synthetic-only", client } as PrivateStorage, objects, deleted };
}

export const png = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpH7DwABpAE8sdwFIwAAAABJRU5ErkJggg==",
	"base64",
);
