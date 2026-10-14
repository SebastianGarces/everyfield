"use server";

import { isAccessKind, validateAccessRequest, type AccessRequestFields, type AccessRequestKind, type AccessRequestResult } from "./contract";

/**
 * Receives one early access request from /access.
 *
 * Stub (task E3): it validates and answers "received". Nothing is stored or sent yet.
 * Task E4 makes it real behind the same signature: store the request, apply duplicate and rate limits,
 * answer a filled honeypot with a fake "received", mail the owner inbox, and return "unavailable" when
 * storage or mail fails (the page then shows the contact fallback and never claims success).
 */
export async function submitAccessRequest(kind: AccessRequestKind, fields: AccessRequestFields): Promise<AccessRequestResult> {
  // Server actions are a public endpoint: parse everything that arrives.
  if (!isAccessKind(kind) || typeof fields !== "object" || fields === null) return { status: "invalid", fieldErrors: {} };
  const v = validateAccessRequest(kind, fields);
  if (!v.ok) return { status: "invalid", fieldErrors: v.fieldErrors };
  return { status: "received" };
}
