import { avatarBytes, storeAvatarBytes } from "@/features/settings/server";

// One photo version of your own account (REQ-IDN-006, avatarRoute in the settings contract). PUT sends the bytes of
// a staged upload; GET returns the current version. Both check the live session and that the account is the
// viewer's own. No storage key or bearer URL leaves the server.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store" };
/** The contract's upper limit for one photo. */
const MAX_BYTES = 3 * 1024 * 1024;

type Params = { params: Promise<{ accountId: string; versionId: string }> };

export async function PUT(request: Request, { params }: Params) {
	const { accountId, versionId } = await params;
	const declared = Number(request.headers.get("content-length") ?? NaN);
	if (!(declared > 0 && declared <= MAX_BYTES)) return new Response(null, { status: 413, headers: PRIVATE });
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.length !== declared) return new Response(null, { status: 400, headers: PRIVATE });
	const stored = await storeAvatarBytes(accountId, versionId, bytes);
	const status = stored === "stored" ? 204 : stored === "invalid" ? 422 : 404;
	return new Response(null, { status, headers: PRIVATE });
}

export async function GET(_request: Request, { params }: Params) {
	const { accountId, versionId } = await params;
	const bytes = await avatarBytes(accountId, versionId);
	if (!bytes) return new Response(null, { status: 404, headers: PRIVATE });
	return new Response(Buffer.from(bytes), { headers: { ...PRIVATE, "Content-Type": mediaType(bytes) } });
}

/** The upload checked the bytes against one of the three allowed types; their signature names it again. */
function mediaType(bytes: Uint8Array) {
	if (bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
	return "image/webp";
}
