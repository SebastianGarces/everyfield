import type { NativePorts } from "@everyfield/evry";
import "server-only";
import { settingsCommands } from "../../features/settings/server.ts";
import { invitationService, invitationServiceOn } from "../invitations/index.ts";
import { current as organizationMount } from "../organizations/index.ts";

/**
 * The native services Evry's seat, Settings, sharing, connection, account and organization tools call (T-327): the
 * invitation, organization and Settings mounts the Settings screens use, so a tool gets exactly their result or
 * refusal. Null when the deployment lacks their configuration; those tools then refuse as unavailable.
 */
export function evryNative(): NativePorts | null {
	const settings = settingsCommands();
	const organizations = organizationMount();
	if (!settings || !organizations || !invitationService()) return null;
	return {
		invitations: (db) => invitationServiceOn(db)!,
		organizations: organizations.adapter,
		settings: settings.settings,
		account: settings.account,
	};
}
