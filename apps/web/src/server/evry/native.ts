import type { NativePorts } from "@everyfield/evry";
import "server-only";
import { appVersion } from "../app-version.ts";
import { settingsCommands } from "../../features/settings/server.ts";
import { invitationServiceOn } from "../invitations/index.ts";
import { launchMount } from "../../features/launch/mount.ts";
import { onboardingMount } from "../../features/onboarding/mount.ts";
import { current as organizationMount } from "../../features/organizations/mount.ts";

export function evryNative(): NativePorts {
	const settings = settingsCommands();
	return {
		invitations: invitationServiceOn,
		organizations: organizationMount().adapter,
		settings: settings.settings,
		account: settings.account,
		onboarding: onboardingMount().producer,
		appVersion: appVersion(),
		launchNotices: launchMount().notices,
	};
}
