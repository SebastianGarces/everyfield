import "server-only";
import { authorizeSettingsMail, type CredentialConfig, type DeletionEffects } from "@everyfield/domain/settings";
import { createHmac, randomUUID } from "node:crypto";
import { database } from "../../server/database.ts";
import {
	createMailService,
	MAIL_PASSES,
	runDueMail,
	type MailPass,
	type MailTransport,
	protectedTemplate,
} from "@everyfield/domain/jobs";
import { serverConfig, type ServerConfig } from "../../server/config.ts";
import { workspaceDeletionContent } from "./deletion-mail.ts";

function settingsMailService(v: ServerConfig, transport?: MailTransport) {
	const addressKey = Buffer.from(v.IDENTITY_ADDRESS_KEY, "hex");
	const addressHash = (address: string) =>
		createHmac("sha256", addressKey).update(address.trim().toLowerCase()).digest("hex");
	return createMailService({
		db: database(v.IDENTITY_DATABASE_URL),
		encryptionKey: Buffer.from(v.IDENTITY_MAIL_KEY, "hex"),
		addressKey,
		from: v.IDENTITY_MAIL_FROM,
		authorize: (tx, list) => authorizeSettingsMail(tx, list, addressHash),
		transport,
	});
}

export function settingsMail(): Pick<CredentialConfig, "deliverVerification" | "securityNotice"> &
	Pick<DeletionEffects, "workspaceNotice"> {
	const config = serverConfig();
	const origin = config.IDENTITY_ORIGIN;
	const mail = settingsMailService(config);
	return {
		deliverVerification: async (tx, i, writes) => {
			const url = `${origin}/confirm-email?token=${encodeURIComponent(i.token)}`;
			await mail.append(
				tx,
				{
					owner: { kind: "account", id: i.accountId },
					purpose: "email_change",
					logicalKey: `email-change/${randomUUID()}`,
					recipient: i.accountId,
					address: i.address,
					content: protectedTemplate({ purpose: "email_change", url }, origin),
					operation: null,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				writes,
			);
		},
		securityNotice: (tx, i, writes) =>
			mail.append(
				tx,
				{
					owner: { kind: "account", id: i.accountId },
					purpose: "notification",
					logicalKey: `security/${i.correlationId}`,
					recipient: i.accountId,
					address: i.address,
					content:
						i.action === "password_changed"
							? {
									subject: "Your Everyfield password changed",
									text: "The password for your Everyfield account changed. Other devices were signed out.\n\nIf you did not change it, reset your password now.",
								}
							: {
									subject: "Your Everyfield sign-in email changed",
									text: "The email you use to sign in to Everyfield changed. This address no longer signs in.\n\nIf you did not change it, contact Everyfield support now.",
								},
					operation: null,
					notice: null,
					eligibleAt: new Date().toISOString(),
				},
				writes,
			),
		workspaceNotice: async (tx, notice, writes) => {
			for (const recipient of notice.recipients)
				await mail.append(
					tx,
					{
						owner: { kind: "account", id: recipient.accountId },
						purpose: "notification",
						logicalKey: `workspace-deletion/${notice.kind}/${notice.requestId}`,
						recipient: recipient.accountId,
						address: recipient.address,
						content: workspaceDeletionContent(notice, recipient, origin),
						operation: null,
						notice: null,
						eligibleAt: new Date().toISOString(),
					},
					writes,
				);
		},
	};
}

export function settingsMailPass(transport: MailTransport): MailPass {
	const config = serverConfig();
	const db = database(config.IDENTITY_DATABASE_URL),
		mail = settingsMailService(config, transport);
	return (limit, until) => runDueMail(db, mail, MAIL_PASSES.settings, limit, until);
}
