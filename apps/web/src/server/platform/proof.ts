import "server-only";
import pg from "pg";
import { z } from "zod";
import { proofEnabled, exactOrigin, boundedBytes, safeBoundary, safeResponse, Refusal, privateHeaders, secretMatches } from "./boundary.ts";
import { createPlatformAuth } from "./auth.ts";
import { currentScope, transaction } from "./database.ts";
import { uploadInput, uploadIntent, finalizeObject, authorizedDownload, storageFromEnvironment } from "./storage.ts";
import { authorizedStream } from "./stream.ts";
import { claimJob, publishJob } from "./execution.ts";
import { receiveCallback } from "./webhook.ts";
import { platformReadiness } from "./readiness.ts";
import { writeRequiredConsequences } from "@everyfield/contracts/common";

let configured: { db: pg.Pool; auth: ReturnType<typeof createPlatformAuth>; origin: string } | undefined;
function runtime() {
  if (configured) return configured;
  const { PLATFORM_DATABASE_URL, PLATFORM_PROOF_ORIGIN: origin, BETTER_AUTH_SECRET: secret } = process.env;
  if (!PLATFORM_DATABASE_URL || !origin || !secret) throw new Refusal("unavailable", 503);
  const url = new URL(PLATFORM_DATABASE_URL);
  if (!["ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech", "ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech"].includes(url.hostname)) throw new Refusal("unavailable", 503);
  const connection = { connectionString: PLATFORM_DATABASE_URL, options: "-c search_path=wp003_proof", connectionTimeoutMillis: 5000, idleTimeoutMillis: 5000 };
  const db = new pg.Pool({ ...connection, max: 4 });
  // Auth queries cannot wait for a connection held by their own domain transaction.
  const authDb = new pg.Pool({ ...connection, max: 2 });
  configured = { db, origin, auth: createPlatformAuth(authDb, origin, secret, async () => { /* Synthetic recovery sink. Never mail a real address. */ }, "/api/platform-proof/auth") };
  return configured;
}
async function parse<T extends z.ZodType>(request: Request, schema: T): Promise<z.output<T>> {
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await boundedBytes(request, 16_384))); } catch { throw new Refusal("invalid_input", 422); }
  const parsed = schema.safeParse(body); if (!parsed.success) throw new Refusal("invalid_input", 422); return parsed.data;
}
// Atomic identifier budgets. The proof trusts no forwarded IP header. Production
// trusted-ingress/IP extraction belongs to the real auth adapter in WP-005.
async function authBudget(db: pg.Pool, kind: string, identifier: string) {
  await transaction(db, async tx => {
    const key = `${kind}:${identifier.trim().toLowerCase()}`;
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [key]);
    const limit = kind === "request-password-reset" ? 3 : 5;
    const window = kind === "request-password-reset" ? "1 hour" : "15 minutes";
    const row = (await tx.query<{ n: number }>('SELECT count(*)::int n FROM proof_rate WHERE key=$1 AND at>clock_timestamp()-$2::interval', [key, window])).rows[0];
    if (!row || row.n >= limit) throw new Refusal("rate_limited", 429);
    await tx.query('INSERT INTO proof_rate(key) VALUES($1)', [key]);
    await tx.query("DELETE FROM proof_rate WHERE at<clock_timestamp()-interval '24 hours'");
  });
}
const email = z.email().max(254);
const password = z.string().min(1).max(1024);
const authInputs = {
  "sign-up/email": z.strictObject({ email, password, name: z.string().trim().min(1).max(100) }),
  "sign-in/email": z.strictObject({ email, password }),
  "request-password-reset": z.strictObject({ email }),
  "reset-password": z.strictObject({ token: z.string().min(1).max(512), newPassword: password }),
  "change-password": z.strictObject({ currentPassword: password, newPassword: password, revokeOtherSessions: z.literal(true) }),
  "sign-out": z.strictObject({}),
};
const subject = z.strictObject({ ownerId: z.uuid(), id: z.uuid() });
const updateInput = subject.extend({ expectedRevision: z.string().regex(/^\d+$/), value: z.string().max(100), failHistory: z.boolean().default(false) });
export async function handleProof(request: Request): Promise<Response> {
  // Also guard direct invocation; production exits before configuration or imports
  // can construct any database/auth/storage client.
  if (!proofEnabled(request)) return new Response(null, { status: 404, headers: privateHeaders });
  return safeBoundary(async () => {
    const path = new URL(request.url).pathname.replace(/^\/api\/platform-proof\//, "");
    const { db, auth, origin } = runtime();
    if (!["GET", "POST"].includes(request.method)) return safeResponse({ code: "unavailable" }, 404);
    if (request.method === "POST" && path !== "webhook") exactOrigin(request, origin);
    if (path.startsWith("auth/")) {
      const action = path.slice(5);
      if (request.method === "GET" && action === "get-session") {
        const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
        return safeResponse(session ? { user: { id: session.user.id }, expiresAt: session.session.expiresAt } : null);
      }
      if (request.method !== "POST" || !["sign-up/email", "sign-in/email", "request-password-reset", "reset-password", "change-password", "sign-out"].includes(action)) return safeResponse({ code: "unavailable" }, 404);
      const schema = Object.entries(authInputs).find(([name]) => name === action)?.[1];
      if (!schema) throw new Refusal("unavailable", 404);
      const input = await parse(request, schema);
      let identifier: string | null = "email" in input ? input.email : null;
      if (action === "change-password" && "currentPassword" in input && "newPassword" in input) {
        if (input.currentPassword === input.newPassword) throw new Refusal("invalid_input", 422);
        const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
        if (!session) throw new Refusal("unavailable", 404);
        identifier = session.user.email;
      }
      if (identifier && ["sign-in/email", "request-password-reset", "change-password"].includes(action)) await authBudget(db, action, identifier);
      const response = await auth.handler(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(input) }));
      if (!response.ok) return safeResponse({ code: response.status === 429 ? "rate_limited" : "unavailable" }, response.status >= 500 ? 503 : response.status);
      if (identifier && ["sign-in/email", "change-password"].includes(action)) await db.query('DELETE FROM proof_rate WHERE key=$1', [`${action}:${identifier.trim().toLowerCase()}`]);
      const headers = new Headers(privateHeaders);
      for (const cookie of response.headers.getSetCookie()) headers.append("Set-Cookie", cookie);
      return Response.json({ status: true }, { headers });
    }
    if (path === "webhook" && request.method === "POST") return safeResponse(await receiveCallback(db, request, process.env.PLATFORM_WEBHOOK_SECRET ?? ""));
    if (path === "readiness" && request.method === "GET") return safeResponse(platformReadiness());
    if (path === "stream" && request.method === "GET") {
      const input = subject.pick({ ownerId: true }).safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!input.success) throw new Refusal("invalid_input", 422);
      return authorizedStream(db, auth, request, input.data.ownerId);
    }
    if (path === "execute" && request.method === "POST") {
      if (!secretMatches(request.headers.get("x-executor-key"), process.env.PLATFORM_EXECUTOR_SECRET)) throw new Refusal("unavailable", 404);
      const claim = await claimJob(db); return safeResponse({ completed: claim ? await publishJob(db, claim) : false });
    }
    if (path === "update" && request.method === "POST") {
      const input = await parse(request, updateInput);
      return safeResponse(await transaction(db, async tx => {
        await currentScope(tx, auth, request.headers, input.ownerId);
        const row = (await tx.query<{ revision: string }>('SELECT revision::text FROM proof_subject WHERE id=$1 AND owner_id=$2 AND active FOR UPDATE', [input.id, input.ownerId])).rows[0];
        if (!row) throw new Refusal("unavailable", 404);
        if (row.revision !== input.expectedRevision) throw new Refusal("conflict", 409);
        return writeRequiredConsequences(tx, {
          async facts(tx) { const updated = (await tx.query<{ revision: string }>('UPDATE proof_subject SET value=$2,revision=revision+1 WHERE id=$1 RETURNING revision::text', [input.id, input.value])).rows[0]; if (!updated) throw new Refusal("unavailable", 404); return updated; },
          async history(tx, result) { await tx.query('INSERT INTO proof_audit(subject,revision) VALUES($1,$2)', [input.failHistory ? null : input.id, result.revision]); },
          async receipt(tx, result) { await tx.query('INSERT INTO proof_receipt(subject,revision) VALUES($1,$2)', [input.id, result.revision]); },
          async intents(tx, result) { await tx.query('INSERT INTO proof_intent(subject,revision) VALUES($1,$2)', [input.id, result.revision]); },
        });
      }));
    }
    if (path === "upload-intent" && request.method === "POST") return safeResponse(await uploadIntent(db, auth, request.headers, await parse(request, uploadInput)));
    if (path === "finalize" && request.method === "POST") {
      const input = subject.safeParse(Object.fromEntries(new URL(request.url).searchParams)); if (!input.success) throw new Refusal("invalid_input", 422);
      return safeResponse(await finalizeObject(db, auth, request.headers, storageFromEnvironment(), input.data.ownerId, input.data.id, await boundedBytes(request, 1024 * 1024)));
    }
    if (path === "download" && request.method === "POST") {
      const input = await parse(request, subject.extend({ ttl: z.number().int().min(1).max(60).default(60) }));
      return safeResponse(await authorizedDownload(db, auth, request.headers, storageFromEnvironment(), input.ownerId, input.id, input.ttl));
    }
    return safeResponse({ code: "unavailable" }, 404);
  });
}
