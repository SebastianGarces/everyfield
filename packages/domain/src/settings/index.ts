import type { Clock } from "@everyfield/contracts/common";
import type { DeletionProducer, NativeAccountProducer, SettingsProducer } from "@everyfield/contracts/settings/server";
import "server-only";
import { avatarOperations, type AvatarCleanup } from "./avatar.ts";
import type { Tx } from "./core.ts";
import { deletionOperations, type DeletionEffects } from "./deletion.ts";
import { sectionOperations, type SectionDependencies } from "./sections.ts";
import { timezoneOperations, type PersonalCalendar } from "./timezones.ts";
export function createSettingsProducer(
	deps: SectionDependencies & {
		avatarCleanup: AvatarCleanup;
		deletion: DeletionEffects;
		credentials: Pick<NativeAccountProducer<Tx>, "requestEmailChange" | "confirmEmailChange" | "changePassword">;
		personalCalendar?: PersonalCalendar;
		clock?: Clock;
	},
): SettingsProducer<Tx> &
	Pick<ReturnType<typeof sectionOperations>, "getSection"> &
	NativeAccountProducer<Tx> &
	DeletionProducer<Tx> {
	return {
		...sectionOperations(deps),
		...timezoneOperations(deps.effects, deps.personalCalendar, deps.clock),
		...avatarOperations(deps.avatarCleanup),
		...deletionOperations(deps.deletion),
		...deps.credentials,
	};
}
export { readAvatar, uploadAvatar } from "./avatar.ts";
export { Refusal } from "./core.ts";
export { createAccountCredentials } from "./credentials.ts";
export type { CredentialConfig } from "./credentials.ts";
export { createLifecycleCleanup, issueRestrictedDeletionSession } from "./deletion.ts";
export type { DeletionRequest, DeletionSubject } from "./deletion.ts";
export { sectionOperations } from "./sections.ts";
export type { Principal, SectionViewer, SettingsEffects } from "./sections.ts";
export { timezoneOperations } from "./timezones.ts";
export type { PersonalCalendar } from "./timezones.ts";

export { withSettingsWrite } from "./core.ts";
