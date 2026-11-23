import "server-only";
import { readBoundedBody } from "@everyfield/domain/operations";
import { avatarBytes, storeAvatarBytes } from "./server";
import { mutatingRoute } from "../../server/platform/boundary.ts";

const PRIVATE = { "Cache-Control": "private, no-store" };
const MAX_BYTES = 3 * 1024 * 1024;

type Params = { params: Promise<{ accountId: string; versionId: string }> };

export const avatarPut = mutatingRoute(async function avatarPut(request: Request, { params }: Params) {
	const { accountId, versionId } = await params;
	const declared = Number(request.headers.get("content-length") ?? NaN);
	const bytes = declared > 0 ? await readBoundedBody(request, MAX_BYTES) : null;
	if (!bytes) return new Response(null, { status: 413, headers: PRIVATE });
	if (bytes.length !== declared) return new Response(null, { status: 400, headers: PRIVATE });
	const stored = await storeAvatarBytes(accountId, versionId, bytes);
	const status = stored === "stored" ? 204 : stored === "invalid" ? 422 : 404;
	return new Response(null, { status, headers: PRIVATE });
});

export async function avatarGet(_request: Request, { params }: Params) {
	const { accountId, versionId } = await params;
	const bytes = await avatarBytes(accountId, versionId);
	if (!bytes) return new Response(null, { status: 404, headers: PRIVATE });
	return new Response(Buffer.from(bytes), { headers: { ...PRIVATE, "Content-Type": mediaType(bytes) } });
}

function mediaType(bytes: Uint8Array) {
	if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	return "image/webp";
}
