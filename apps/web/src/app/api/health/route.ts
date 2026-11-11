import { liveness } from "@everyfield/domain/operations";
import { safeResponse } from "../../../server/platform/boundary";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
	return safeResponse(liveness());
}
