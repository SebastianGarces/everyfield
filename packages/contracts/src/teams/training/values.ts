import { z } from "zod";

export const programName = z.string().trim().min(1).max(200);
export const meetingSubtype = z.enum(["regular", "training", "planning", "special", "rehearsal"]);
export const creditKind = z.enum(["earned", "revoked", "service"]);
