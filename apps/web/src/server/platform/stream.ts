import "server-only";
import type { Pool } from "pg";
import type { PlatformAuth } from "./auth.ts";
import { currentScope, transaction } from "./database.ts";
import { privateHeaders, Refusal } from "./boundary.ts";

export async function authorizedStream(db: Pool, auth: PlatformAuth, request: Request, owner: string) {
  const cursor = request.headers.get("last-event-id") ?? "0";
  if (!/^\d{1,10}$/.test(cursor)) throw new Refusal("invalid_input", 422);
  await transaction(db, tx => currentScope(tx, auth, request.headers, owner));
  let after = Number(cursor); let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const until = Date.now() + 2000;
      try {
        while (!cancelled && !request.signal.aborted && Date.now() < until) {
          const rows = await transaction(db, async tx => {
            await currentScope(tx, auth, request.headers, owner);
            return (await tx.query<{ id: string; status: string }>('SELECT id::text,status FROM proof_stream WHERE owner_id=$1 AND id>$2 ORDER BY id LIMIT 10', [owner, after])).rows;
          });
          for (const row of rows) {
            if (cancelled || request.signal.aborted) break;
            // Only the closed progress projection crosses the wire. Reconnect is read-only.
            controller.enqueue(new TextEncoder().encode(`id: ${row.id}\nevent: progress\ndata: ${JSON.stringify({ status: row.status })}\n\n`)); after = Number(row.id);
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch { /* Fresh denial closes without revealing why or what exists. */ }
      finally { if (!cancelled) controller.close(); }
    },
    cancel() { cancelled = true; },
  });
  return new Response(stream, { headers: { ...privateHeaders, "Content-Type": "text/event-stream", "X-Accel-Buffering": "no" } });
}
