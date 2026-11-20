import "server-only";
import { readBoundedBody } from "@everyfield/domain/operations";
import { readPreview } from "./server.ts";
import { mutatingRoute } from "../../server/platform/boundary.ts";
import { parseJson } from "../../server/platform/json.ts";

const NO_STORE = { "Cache-Control": "private, no-store" };
const BODY_MAX = 64 * 1024;
const invalid = () => Response.json({ status: "refused", code: "invalid_input" }, { headers: NO_STORE });

export const previewRoute = mutatingRoute(async function previewRoute(request: Request) {
	const bytes = await readBoundedBody(request, BODY_MAX);
	if (!bytes)
		return Response.json({ status: "refused", code: "invalid_input", path: "overrides" }, { headers: NO_STORE });
	const raw = parseJson(bytes);
	if (!raw || typeof raw !== "object") return invalid();
	const body = raw as { templateId?: unknown; format?: unknown; overrides?: unknown };
	if (
		typeof body.templateId !== "string" ||
		(body.format !== "pdf" && body.format !== "docx" && body.format !== "xlsx")
	)
		return invalid();
	const overrides: Record<string, string> = {};
	if (body.overrides !== undefined) {
		if (!body.overrides || typeof body.overrides !== "object" || Array.isArray(body.overrides)) return invalid();
		for (const [key, value] of Object.entries(body.overrides)) {
			if (typeof value !== "string") return invalid();
			overrides[key] = value;
		}
	}
	return Response.json(await readPreview(body.templateId, body.format, overrides), { headers: NO_STORE });
});
