import { z } from "zod";

export const programName = z.string().trim().min(1).max(200);
export const creditKind = z.enum(["earned", "revoked", "service"]);
