import { S3Client } from "../../../packages/db/src/schema/storage.ts";
import { present } from "./support.mts";

export class MemoryClient extends S3Client {
	objects = new Map<string, Buffer>();
	beforePut: (() => Promise<unknown>) | null = null;
	constructor() {
		super({
			region: "us-east-1",
			endpoint: "https://example.invalid",
			forcePathStyle: true,
			credentials: { accessKeyId: "test", secretAccessKey: "test" },
		});
	}
	override async send(command: { input?: { Key?: string; Body?: Uint8Array } }) {
		const input = command.input ?? {};
		const key = String(input.Key);
		switch (command.constructor.name) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "PutObjectCommand": {
				const hold = this.beforePut;
				this.beforePut = null;
				await hold?.();
				this.objects.set(key, Buffer.from(present(input.Body)));
				return {};
			}
			case "GetObjectCommand": {
				const body = this.objects.get(key);
				if (!body) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
				return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
			}
			case "DeleteObjectCommand":
				this.objects.delete(key);
				return {};
			default:
				throw new Error(`unexpected provider operation ${command.constructor.name}`);
		}
	}
}
