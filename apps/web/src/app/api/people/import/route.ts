export { importRoute as POST, receiptRoute as GET } from "@/features/people/import-export/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The import job runs after the response, inside this function's lifetime.
export const maxDuration = 300;
