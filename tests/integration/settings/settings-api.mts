import {
	avatarOperations,
	deletionOperations,
	sectionOperations,
	timezoneOperations,
} from "../../../packages/domain/src/settings/index.ts";

export function settingsApi(deps) {
	return {
		...sectionOperations(deps),
		...timezoneOperations(deps.effects, deps.personalCalendar, deps.clock),
		...avatarOperations(deps.avatarCleanup),
		...deletionOperations(deps.deletion),
		...deps.credentials,
	};
}
