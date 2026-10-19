import "server-only";
export { createIdentityService } from "./service.ts";
export type { IdentityConfig, IdentityMail } from "./service.ts";
export { trustedIdentityIp } from "./ingress.ts";
export { createInvitationService } from "./invitations.ts";
export type { InvitationConfig, InvitationMail } from "./invitations.ts";
export { InvitationRefusal } from "./invitation-core.ts";
export { createSeatService } from "./seats.ts";
export { authorizeInvitationMail } from "./invitation-mail.ts";

export { readIdentitySession, readAccountContact } from "./reads.ts";
