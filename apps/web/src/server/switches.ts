import "server-only";
import { mailDelay, readSwitches, type MailDelay } from "@everyfield/domain/flags";
import { cache } from "react";
import { requestDatabase } from "./database";

export const requestSwitches = cache(() => readSwitches(requestDatabase()));

export const requestMailDelay = (): Promise<MailDelay> => mailDelay(requestSwitches);

export async function withMailDelay<R extends { status: string }>(reply: R): Promise<R & MailDelay> {
	return reply.status === "ok" ? { ...reply, ...(await requestMailDelay()) } : reply;
}
