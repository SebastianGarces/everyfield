import { safeResponse } from "../../../../server/platform/boundary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// No live callback subscription or credential is installed by this producer.
export function POST() {
	return safeResponse({ code: "unavailable" }, 404);
}
