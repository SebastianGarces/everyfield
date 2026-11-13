import { z } from "zod";
import { safeReturn } from "./navigation.ts";
import { requestKey } from "../common/values.ts";

/**
 * How long a password-reset or sign-up verification link works. The scheduled runner expires queued link mail older
 * than this, so a backlog never sends a dead link.
 */
export const IDENTITY_LINK_SECONDS = 3600;

export const normalizedEmail = z.string().trim().toLowerCase().pipe(z.email());
// Native secrets are never trimmed, normalized or placed in durable contracts.
export const nativePassword = z.string().min(8).max(1024);
const proof = z.string().min(1).max(4096);
const name = z.string().trim().min(1).max(200);
export const accountKind = z.enum(["plant_precreation", "discovery", "sending_church", "sending_network"]);

const identity = { email: normalizedEmail, password: nativePassword, name, requestKey };
export const registrationRequest = z.discriminatedUnion("kind", [
	z.strictObject({ ...identity, kind: z.literal("plant_precreation") }),
	z.strictObject({ ...identity, kind: z.literal("discovery") }),
	z.strictObject({ ...identity, kind: z.literal("sending_church"), organizationName: name }),
	z.strictObject({ ...identity, kind: z.literal("sending_network"), organizationName: name }),
	// The server derives the advertised kind, recipient and role from the live proof.
	z.strictObject({ ...identity, kind: z.literal("invitation"), invitationProof: proof }),
]);
export const resumeRegistrationRequest = z.strictObject({ requestKey, invitationProof: proof.optional() });
export const signInRequest = z.strictObject({
	email: normalizedEmail,
	password: z.string().min(1).max(1024),
	returnTo: z
		.string()
		.transform((value) => safeReturn(value))
		.optional(),
});
export const passwordRecoveryRequest = z.strictObject({ email: normalizedEmail });
export const recoverPasswordRequest = z
	.strictObject({ proof, newPassword: nativePassword, confirmPassword: nativePassword })
	.refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"], message: "Passwords must match" });
// Current-secret proof and the unchanged-secret refusal belong to the auth adapter.
// Client input cannot choose the actor/session or override revocation policy.
export const changePasswordRequest = z
	.strictObject({
		currentPassword: z.string().min(1).max(1024),
		newPassword: nativePassword,
		confirmPassword: nativePassword,
	})
	.refine((v) => v.newPassword === v.confirmPassword, { path: ["confirmPassword"], message: "Passwords must match" });
export const verifyEmailRequest = z.strictObject({ proof });
export const selfSessionRequest = z.strictObject({});
