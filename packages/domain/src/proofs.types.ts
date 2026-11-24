import type { sessionId } from "@everyfield/contracts/common";
import type { z } from "zod";
import type { OrganizationEffects } from "./organizations/index.ts";
import type { createAccountCredentials } from "./settings/index.ts";
import type { connectionLink, deletionCookieValue, invitationLink } from "./proofs.ts";

type Refused<Target, Value> = [Value] extends [Target] ? false : true;

type Invitation = Parameters<typeof invitationLink>[1];
export const anInvitationProofIsNotAString: Refused<string, Invitation> = true;
export const aStringIsNotAnInvitationProof: Refused<Invitation, string> = true;

type Connection = Parameters<typeof connectionLink>[2];
export const aConnectionProofIsNotAString: Refused<string, Connection> = true;
export const aStringIsNotAConnectionProof: Refused<Connection, string> = true;
type Effect = Parameters<OrganizationEffects["invitation"]>[1]["proof"];
export const anEffectProofIsNotAString: Refused<string, Effect> = true;
export const aStringIsNotAnEffectProof: Refused<Effect, string> = true;
export const anInvitationProofIsNotAConnectionProof: Refused<Connection, Invitation> = true;

type Cookie = Parameters<typeof deletionCookieValue>[0];
export const aCookieProofIsNotAString: Refused<string, Cookie> = true;
export const aStringIsNotACookieProof: Refused<Cookie, string> = true;
type Opened<Open extends "openAccountDeletion" | "openWorkspaceDeletion"> = Extract<
	Awaited<ReturnType<ReturnType<typeof createAccountCredentials>[Open]>>,
	{ status: "ok" }
>["value"]["session"]["handle"];
export const anAccountHandleIsNotAString: Refused<string, Opened<"openAccountDeletion">> = true;
export const aStringIsNotAnAccountHandle: Refused<Opened<"openAccountDeletion">, string> = true;
export const anAccountHandleIsNotASessionId: Refused<z.infer<typeof sessionId>, Opened<"openAccountDeletion">> = true;
export const aWorkspaceHandleIsNotAString: Refused<string, Opened<"openWorkspaceDeletion">> = true;
export const aStringIsNotAWorkspaceHandle: Refused<Opened<"openWorkspaceDeletion">, string> = true;
export const aWorkspaceHandleIsNotASessionId: Refused<
	z.infer<typeof sessionId>,
	Opened<"openWorkspaceDeletion">
> = true;
