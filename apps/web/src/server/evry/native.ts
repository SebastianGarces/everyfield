import type { NativePorts } from "@everyfield/evry";
import "server-only";
import { settingsCommands } from "../../features/settings/server.ts";
import { invitationService, invitationServiceOn } from "../invitations/index.ts";
import { onboardingMount } from "../onboarding/index.ts";
import { current as organizationMount } from "../organizations/index.ts";

/**
 * The native services Evry's seat, Settings, sharing, connection, account and organization tools (T-327) and its setup
 * and Discovery tools (T-345) call: the invitation, organization and Settings mounts the Settings screens use and the
 * onboarding mount `/onboarding` uses, so a tool gets exactly their result or refusal. Null when the deployment lacks their configuration; those tools then refuse as unavailable.
 */
export function evryNative(): NativePorts | null {
	const settings = settingsCommands();
	const organizations = organizationMount();
	const onboarding = onboardingMount();
	if (!settings || !organizations || !onboarding || !invitationService()) return null;
	return {
		invitations: (db) => invitationServiceOn(db)!,
		organizations: organizations.adapter,
		settings: settings.settings,
		account: settings.account,
		onboarding: onboarding.producer,
	};
}
