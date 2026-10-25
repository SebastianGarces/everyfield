import "server-only";
import { readPreview } from "./server.ts";

// Preview and download bytes. A server action on /documents also renders a flight reply, and that reply exceeded
// one second. This route returns the same preview as JSON. Nothing is stored.

const NO_STORE = { "Cache-Control": "private, no-store" };
const BODY_MAX = 64 * 1024;

export async function previewRoute(request: Request) {
	if (Number(request.headers.get("content-length") ?? 0) > BODY_MAX)
		return Response.json({ status: "refused", code: "invalid_input" }, { headers: NO_STORE });
	let raw: unknown;
	try {
		raw = await request.json();
	} catch {
		return Response.json({ status: "lost" }, { headers: NO_STORE });
	}
	if (!raw || typeof raw !== "object") return Response.json({ status: "lost" }, { headers: NO_STORE });
	const body = raw as { templateId?: unknown; format?: unknown; overrides?: unknown };
	if (
		typeof body.templateId !== "string" ||
		(body.format !== "pdf" && body.format !== "docx" && body.format !== "xlsx")
	)
		return Response.json({ status: "lost" }, { headers: NO_STORE });
	const overrides: Record<string, string> = {};
	if (body.overrides !== undefined) {
		if (!body.overrides || typeof body.overrides !== "object" || Array.isArray(body.overrides))
			return Response.json({ status: "lost" }, { headers: NO_STORE });
		for (const [key, value] of Object.entries(body.overrides)) {
			if (typeof value !== "string") return Response.json({ status: "lost" }, { headers: NO_STORE });
			overrides[key] = value;
		}
	}
	return Response.json(await readPreview(body.templateId, body.format, overrides), { headers: NO_STORE });
}
