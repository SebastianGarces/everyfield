import "server-only";
import { sql } from "@everyfield/db/query";
import { createHmac } from "node:crypto";
import { z } from "zod";
import { database } from "../../server/database.ts";
import type { OperatorMail, OperatorNotice } from "../../server/jobs/feedback-publication.ts";
import {
	createMailService,
	MAIL_PASSES,
	runDueMail,
	type MailPass,
	type MailTransport,
} from "../../server/jobs/mail.ts";
import { serverConfig, serverEnv, type ServerConfig, type ServerEnv } from "../../server/config.ts";

const operatorAddress = z.email().max(320);
const KEY = /^feedback\/([0-9a-f-]{36})$/;

const operatorInbox = (source: ServerEnv) => operatorAddress.safeParse(source.FEEDBACK_OPERATOR_EMAIL).data ?? null;

export const operatorMailConfigured = (source: ServerEnv = serverEnv()) => operatorInbox(source) !== null;

function feedbackMailService(v: ServerConfig, address: string, transport?: MailTransport) {
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const inbox = createHmac("sha256", addressKey).update(address.trim().toLowerCase()).digest("hex");
	return createMailService({
		db: database(v.IDENTITY_DATABASE_URL),
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey,
		from: v.IDENTITY_MAIL_FROM,
		authorize: async (tx, list) => {
			const wanted = list.flatMap((m) => {
				const key = KEY.exec(m.logicalKey);
				return key && m.purpose === "notification" && m.recipient === null && m.addressHash === inbox
					? [{ id: m.id, feedback: key[1], account: m.tenant }]
					: [];
			});
			if (!wanted.length) return new Set();
			const found = await tx.execute(
				sql`SELECT w.id FROM jsonb_to_recordset(${JSON.stringify(wanted)}::jsonb) w(id uuid,feedback uuid,account uuid)
 JOIN feedback f ON f.id=w.feedback AND f.account_id=w.account`,
			);
			return new Set(found.rows.map((r) => z.uuid().parse(r.id)));
		},
		transport,
	});
}

function operatorContent(notice: Omit<OperatorNotice, "tenant" | "feedbackId">, origin: string) {
	const triage = `Triage it in Everyfield: ${origin}/feedback/triage`;
	if (!notice.issue)
		return {
			subject: "Feedback held for triage",
			text: `A feedback report was submitted. Nothing was published: it is held for triage. Reference: ${notice.reference}.\n\n${triage}`,
		};
	const link = notice.url ? `Public issue: ${notice.url}` : "No public issue was published: it is held for triage.";
	return { subject: notice.issue.title, text: `${notice.issue.body}\n\n${link}\n\n${triage}` };
}

export function operatorMail(source: ServerEnv = serverEnv()): OperatorMail | null {
	const address = operatorInbox(source);
	if (!address) return null;
	const v = serverConfig();
	const mail = feedbackMailService(v, address);
	return (notice) =>
		mail.queued([
			{
				owner: { kind: "account", id: notice.tenant },
				purpose: "notification",
				logicalKey: `feedback/${notice.feedbackId}`,
				recipient: null,
				address,
				content: operatorContent(notice, new URL(v.IDENTITY_ORIGIN).origin),
				operation: null,
				notice: null,
				eligibleAt: new Date().toISOString(),
			},
		]).ctes;
}

export function feedbackMailPass(transport: MailTransport): MailPass | null {
	const address = operatorInbox(serverEnv());
	if (!address) return null;
	const v = serverConfig();
	const db = database(v.IDENTITY_DATABASE_URL),
		mail = feedbackMailService(v, address, transport);
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.feedback, limit, until);
}
