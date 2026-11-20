import "server-only";
import { readBoundedBody } from "@everyfield/domain/operations";
import { brandAsset, storeBrandBytes } from "./server";
import { ASSET_MAX_BYTES } from "@everyfield/contracts/branding";
import { mutatingRoute } from "../../../server/platform/boundary.ts";

const PRIVATE = { "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUSAL_STATUS = { invalid_file: 422, access_denied: 403, unavailable: 503 } as const;

type Params = { params: Promise<{ id: string }> };

export const brandAssetPut = mutatingRoute(async function brandAssetPut(request: Request, { params }: Params) {
	const { id } = await params;
	const declared = Number(request.headers.get("content-length") ?? NaN);
	if (!UUID.test(id)) return new Response(null, { status: 404, headers: PRIVATE });
	const bytes = declared > 0 ? await readBoundedBody(request, ASSET_MAX_BYTES) : null;
	if (!bytes) return refusal("invalid_file", 413);
	if (bytes.length !== declared) return refusal("invalid_file", 400);
	const stored = await storeBrandBytes(id, bytes);
	if (stored.status === "ok") return new Response(null, { status: 204, headers: PRIVATE });
	const { code, correlationId } = stored.error;
	const status = REFUSAL_STATUS[code as keyof typeof REFUSAL_STATUS] ?? 422;
	return Response.json({ code, correlationId }, { status, headers: PRIVATE });
});

export async function brandAssetGet(request: Request, { params }: Params) {
	const { id } = await params;
	const held = request.headers.get("if-none-match");
	const found = UUID.test(id) ? await brandAsset(id, (sha256) => etagOf(sha256) === held) : null;
	if (found?.status !== "ok") return new Response(null, { status: 404, headers: PRIVATE });
	const { sha256, mediaType, bytes } = found.value;
	const headers = { ...PRIVATE, "Content-Type": mediaType, ETag: etagOf(sha256) };
	if (!bytes) return new Response(null, { status: 304, headers });
	return new Response(Buffer.from(bytes), { headers });
}

function etagOf(sha256: string) {
	return `"${sha256.slice(0, 32)}"`;
}

function refusal(code: keyof typeof REFUSAL_STATUS, status: number) {
	return Response.json({ code, correlationId: crypto.randomUUID() }, { status, headers: PRIVATE });
}
