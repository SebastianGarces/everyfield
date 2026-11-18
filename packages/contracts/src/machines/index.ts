import { deletionMachine } from "./deletion-lifecycle.ts";
import { invitationMachine } from "./invitation.ts";
import { meetingStatusMachine } from "./meeting-status.ts";

export * from "./machine.ts";
export { type DeletionWitness } from "./deletion-lifecycle.ts";
export { invitationPurposes, type InvitationSubject } from "./invitation.ts";
export { deletionMachine, invitationMachine, meetingStatusMachine };

export const machines = [meetingStatusMachine, invitationMachine, deletionMachine] as const;
