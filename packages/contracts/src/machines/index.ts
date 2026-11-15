import { invitationMachine } from "./invitation.ts";
import { meetingStatusMachine } from "./meeting-status.ts";

export * from "./machine.ts";
export { invitationPurposes, type InvitationSubject } from "./invitation.ts";
export { invitationMachine, meetingStatusMachine };

export const machines = [meetingStatusMachine, invitationMachine] as const;
