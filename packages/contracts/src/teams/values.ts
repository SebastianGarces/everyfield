import { z } from "zod";

/** In-code ministry catalog generation. A client that sends another generation is stale. */
export const TEMPLATE_VERSION = "2";
export const teamState = z.enum(["forming", "active", "paused"]);
export const leaderSource = z.enum(["explicit", "role_derived", "legacy"]);
export const templateKey = z.string().trim().min(1).max(80);
export const roleKey = z.string().trim().min(1).max(80);
export const teamName = z.string().trim().min(1).max(200);
export const teamText = z.string().trim().min(1).max(2000);
export const teamIcon = z.string().trim().min(1).max(40);
