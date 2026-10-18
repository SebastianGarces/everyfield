import { mountCallback } from "../../../../../../../ops/maintenance/mount.mts";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// No live callback subscription or credential is installed by this producer.
export const POST = mountCallback(null);
