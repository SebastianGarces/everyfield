import { isIP } from "node:net";
import { z } from "zod";
import { database, recordAccessMail, reserveAccessRequest } from "@everyfield/database";
import { HONEYPOT, isAccessKind, validateAccessRequest, type AccessRequest, type AccessRequestResult } from "./contract";

const mailSchema = z.object({ from: z.string().min(1), to: z.array(z.email()).length(1), reply_to: z.email(), subject: z.string().min(1), text: z.string().min(1) });
const receiptSchema = z.object({ id: z.string().min(1) });

type Dependencies = {
  db?: ReturnType<typeof database>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
};

function mailFor(request: AccessRequest, env: NodeJS.ProcessEnv) {
  const data = request.data;
  const fields = request.kind === "planter"
    ? [["Plant name", request.data.plant_name], ["City", request.data.city], ["Phase", request.data.phase], ["Sending church or network", request.data.sending]]
    : [["Network or church", request.data.organization], ["Role", request.data.role], ["Plants sent or supported", request.data.plants], ["Message", request.data.message]];
  return mailSchema.parse({
    from: env.EMAIL_FROM,
    to: [env.EARLY_ACCESS_EMAIL_TO],
    reply_to: data.email,
    subject: `${env.EARLY_ACCESS_EMAIL_SUBJECT_PREFIX ?? ""}EveryField early access: ${request.kind}`,
    text: [["Form", request.kind], ["Name", data.name], ["Email", data.email], ...fields].map(([label, value]) => `${label}: ${value ?? "(not provided)"}`).join("\n"),
  });
}

/** The public operation. Only PostgreSQL and the Resend HTTP boundary perform effects. */
export async function receiveAccessRequest(kind: unknown, fields: unknown, ip: string | null, dependencies: Dependencies = {}): Promise<AccessRequestResult> {
  if (!isAccessKind(kind) || typeof fields !== "object" || fields === null || Array.isArray(fields)) {
    return { status: "invalid", fieldErrors: {} };
  }
  // Bots get the same receipt even if the other fields are missing or invalid.
  if (HONEYPOT in fields && typeof fields[HONEYPOT] === "string" && fields[HONEYPOT] !== "") {
    return { status: "received" };
  }
  const validation = validateAccessRequest(kind, { ...fields });
  if (!validation.ok) return { status: "invalid", fieldErrors: validation.fieldErrors };
  const request = validation.request;
  try {
    const env = dependencies.env ?? process.env;
    if (!env.RESEND_API_KEY) throw new Error("Mail credentials unavailable");
    const mailPayload = mailFor(request, env);
    const db = dependencies.db ?? database();
    const reservation = await reserveAccessRequest({
      kind: request.kind,
      email: request.data.email,
      data: { ...request.data, [HONEYPOT]: undefined },
      ip: ip && isIP(ip) ? ip : null,
      mailPayload,
    }, db);
    if (reservation.status !== "deliver") return reservation;
    // Resend deduplicates for 24h. Never blindly resend an unresolved older request.
    if (Date.now() - reservation.createdAt.getTime() >= 23 * 60 * 60 * 1000) return { status: "unavailable" };
    const payload = mailSchema.parse(reservation.payload);
    const response = await (dependencies.fetch ?? fetch)("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": `early-access/${reservation.id}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { status: "unavailable" };
    const receipt = receiptSchema.parse(await response.json());
    await recordAccessMail(reservation.id, receipt.id, db);
    return { status: "received" };
  } catch {
    // Never log provider errors or payloads: they can contain credentials or personal data.
    return { status: "unavailable" };
  }
}
