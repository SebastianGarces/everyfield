import { deletionMachine } from "./deletion-lifecycle.ts";
import { proposalMachine } from "./evry-proposal.ts";
import { invitationMachine } from "./invitation.ts";
import { meetingStatusMachine } from "./meeting-status.ts";

export * from "./machine.ts";
export { type DeletionWitness } from "./deletion-lifecycle.ts";
export { type ProposalSubject } from "./evry-proposal.ts";
export { invitationPurposes, type InvitationSubject } from "./invitation.ts";
export { deletionMachine, invitationMachine, meetingStatusMachine, proposalMachine };

export const machines = [meetingStatusMachine, invitationMachine, deletionMachine, proposalMachine] as const;
