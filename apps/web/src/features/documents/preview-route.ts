import "server-only";
import { readBoundedBody } from "@everyfield/domain/operations";
import { readPreview } from "./server.ts";
import { mutatingRoute } from "../../server/platform/boundary.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const BODY_MAX = 64 * 1024;

export const previewRoute = mutatingRoute(async function previewRoute(request: Request) {
	let raw: unknown;
	try {
		const bytes = await readBoundedBody(request, BODY_MAX);
		if (!bytes)
			return Response.json({ status: "refused", code: "invalid_input", path: "overrides" }, { headers: NO_STORE });
		raw = await new Response(bytes).json();
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
});
