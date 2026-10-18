import { healthResponse } from "../../../../../../ops/maintenance/mount.mts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() {
	return healthResponse();
}
