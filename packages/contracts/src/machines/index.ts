import { meetingStatusMachine } from "./meeting-status.ts";

export * from "./machine.ts";
export { meetingStatusMachine };

export const machines = [meetingStatusMachine] as const;
