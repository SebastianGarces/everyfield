"use server";

import { headers } from "next/headers";
import { receiveAccessRequest } from "@everyfield/domain/early-access";
import { trustedIdentityIp } from "@everyfield/domain/identity";
import { HONEYPOT, type AccessRequestFields, type AccessRequestKind, type AccessRequestResult } from "./contract";
import { FIELD_NAMES, LAST_STEP, afterReply, back, isWho, kindOf, next, requestFields, type FormState } from "./steps";

export async function submitAccessRequest(
	kind: AccessRequestKind,
	fields: AccessRequestFields,
): Promise<AccessRequestResult> {
	const ip = trustedIdentityIp({ headers: await headers() }, process.env.VERCEL === "1");
	return receiveAccessRequest(kind, fields, ip);
}

export async function stepAccessForm(_: FormState, data: FormData): Promise<FormState> {
	const str = (k: string) => {
		const v = data.get(k);
		return typeof v === "string" ? v : undefined;
	};
	const values = Object.fromEntries(FIELD_NAMES.flatMap((n) => (str(n) === undefined ? [] : [[n, str(n)!]])));
	const who = str("who");
	const step = Math.min(Math.max(Number(str("step")) || 0, 0), LAST_STEP);
	const status = str("notice") ? "unavailable" : "editing";
	const s: FormState = { step, who: isWho(who) ? who : undefined, values, errors: {}, status };
	const intent = str("intent");
	if (intent === "back") return back(s, values);
	if (intent !== "send" || !s.who || step !== LAST_STEP) return next(s, values);
	const fields = { ...requestFields(s.who, values), [HONEYPOT]: str(HONEYPOT) ?? "" };
	return afterReply(s, values, await submitAccessRequest(kindOf(s.who), fields));
}
