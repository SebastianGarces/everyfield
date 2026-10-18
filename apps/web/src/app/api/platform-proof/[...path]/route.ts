import { proofEnabled } from "@/server/platform/boundary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function handle(request: Request) {
  if (!proofEnabled(request)) return new Response(null, { status: 404, headers: { "Cache-Control": "private, no-store" } });
  const { handleProof } = await import("@/server/platform/proof");
  return handleProof(request);
}
export { handle as GET, handle as POST, handle as PUT, handle as DELETE, handle as PATCH, handle as HEAD, handle as OPTIONS };
