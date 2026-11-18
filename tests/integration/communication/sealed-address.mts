import { createCipheriv, randomBytes } from "node:crypto";

export function sealAddress(key: Uint8Array, value: string, aad: string) {
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, iv);
	cipher.setAAD(Buffer.from(aad));
	const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
	return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}
