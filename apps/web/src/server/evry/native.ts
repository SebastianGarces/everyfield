import type { NativePorts } from "@everyfield/evry";
import "server-only";
import { appVersion } from "../app-version.ts";
import { settingsCommands } from "../../features/settings/server.ts";
import { invitationService, invitationServiceOn } from "../invitations/index.ts";
import { launchMount } from "../../features/launch/mount.ts";
import { onboardingMount } from "../onboarding/index.ts";
import { current as organizationMount } from "../organizations/index.ts";

export function evryNative(): NativePorts | null {
	const settings = settingsCommands();
	const organizations = organizationMount();
	const onboarding = onboardingMount();
	const launch = launchMount();
	if (!settings || !organizations || !onboarding || !invitationService()) return null;
	return {
		invitations: (db) => invitationServiceOn(db)!,
		organizations: organizations.adapter,
		settings: settings.settings,
		account: settings.account,
		onboarding: onboarding.producer,
		appVersion: appVersion(),
		...(launch && { launchNotices: launch.notices }),
	};
}
