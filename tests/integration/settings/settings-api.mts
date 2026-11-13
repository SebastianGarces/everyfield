import {
	avatarOperations,
	deletionOperations,
	sectionOperations,
	timezoneOperations,
} from "../../../packages/domain/src/settings/index.ts";

/**
 * Every settings operation on one object, from the same factories apps/web/src/features/settings/server.ts mounts, so
 * a suite can call any of them by name.
 */
export function settingsApi(deps) {
	return {
		...sectionOperations(deps),
		...timezoneOperations(deps.effects, deps.personalCalendar, deps.clock),
		...avatarOperations(deps.avatarCleanup),
		...deletionOperations(deps.deletion),
		...deps.credentials,
	};
}
