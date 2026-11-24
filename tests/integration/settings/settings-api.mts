import {
	avatarOperations,
	deletionOperations,
	sectionOperations,
	timezoneOperations,
} from "../../../packages/domain/src/settings/index.ts";

type Deps<Credentials extends object> = Parameters<typeof sectionOperations>[0] & {
	effects: Parameters<typeof timezoneOperations>[0];
	personalCalendar?: Parameters<typeof timezoneOperations>[1];
	clock?: Parameters<typeof timezoneOperations>[2];
	avatarCleanup: Parameters<typeof avatarOperations>[0];
	deletion: Parameters<typeof deletionOperations>[0];
	credentials: Credentials;
};

export function settingsApi<Credentials extends object>(deps: Deps<Credentials>) {
	return {
		...sectionOperations(deps),
		...timezoneOperations(deps.effects, deps.personalCalendar, deps.clock),
		...avatarOperations(deps.avatarCleanup),
		...deletionOperations(deps.deletion),
		...deps.credentials,
	};
}
