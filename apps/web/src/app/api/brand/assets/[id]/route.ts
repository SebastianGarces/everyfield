import { brandAssetBytes, storeBrandBytes } from "@/features/settings/brand/server";
import { ASSET_MAX_BYTES } from "@everyfield/contracts/branding";
import { createHash } from "node:crypto";

// Brand asset bytes (REQ-BRD-002). PUT sends the bytes of a staged upload (the id is the upload id); GET returns the
// stored file the kit references now (the id is the file id). Every request rechecks the live session, the Owner or
// Admin seat and the kit's current reference, a 304 revalidation included, so a replaced or removed file, a Member,
// another church and a signed-out visitor all get 404 and no bytes. No storage key or bearer URL leaves the server.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The brand refusals the byte upload can return, as the status the client maps back to the slot message. */
const REFUSAL_STATUS = { invalid_file: 422, access_denied: 403, unavailable: 503 } as const;

type Params = { params: Promise<{ id: string }> };

export async function PUT(request: Request, { params }: Params) {
	const { id } = await params;
	const declared = Number(request.headers.get("content-length") ?? NaN);
	if (!UUID.test(id)) return new Response(null, { status: 404, headers: PRIVATE });
	if (!(declared > 0 && declared <= ASSET_MAX_BYTES)) return refusal("invalid_file", 413);
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.length !== declared) return refusal("invalid_file", 400);
	const stored = await storeBrandBytes(id, bytes);
	if (stored.status === "ok") return new Response(null, { status: 204, headers: PRIVATE });
	const { code, correlationId } = stored.error;
	const status = REFUSAL_STATUS[code as keyof typeof REFUSAL_STATUS] ?? 422;
	return Response.json({ code, correlationId }, { status, headers: PRIVATE });
}

export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const found = UUID.test(id) ? await brandAssetBytes(id) : null;
	if (found?.status !== "ok") return new Response(null, { status: 404, headers: PRIVATE });
	const etag = `"${createHash("sha256").update(found.value.bytes).digest("hex").slice(0, 32)}"`;
	const headers = { ...PRIVATE, "Content-Type": found.value.mediaType, ETag: etag };
	if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
	return new Response(Buffer.from(found.value.bytes), { headers });
}

function refusal(code: keyof typeof REFUSAL_STATUS, status: number) {
	return Response.json({ code, correlationId: crypto.randomUUID() }, { status, headers: PRIVATE });
}
