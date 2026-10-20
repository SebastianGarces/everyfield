import "server-only";
import type { Clock } from "@everyfield/contracts/common";
import type { SettingsProducer, NativeAccountProducer, DeletionProducer } from "@everyfield/contracts/settings/server";
import type { Tx } from "./core.ts";
import { sectionOperations, type SectionDependencies } from "./sections.ts";
import { timezoneOperations, type PersonalCalendar } from "./timezones.ts";
import { avatarOperations, type AvatarCleanup } from "./avatar.ts";
import { deletionOperations, type DeletionEffects } from "./deletion.ts";
export function createSettingsProducer(
	deps: SectionDependencies & {
		avatarCleanup: AvatarCleanup;
		deletion: DeletionEffects;
		credentials: Pick<NativeAccountProducer<Tx>, "requestEmailChange" | "confirmEmailChange" | "changePassword">;
		personalCalendar?: PersonalCalendar;
		clock?: Clock;
	},
): SettingsProducer<Tx> & NativeAccountProducer<Tx> & DeletionProducer<Tx> {
	return {
		...sectionOperations(deps),
		...timezoneOperations(deps.effects, deps.personalCalendar, deps.clock),
		...avatarOperations(deps.avatarCleanup),
		...deletionOperations(deps.deletion),
		...deps.credentials,
	};
}
export { createAccountCredentials } from "./credentials.ts";
export type { CredentialConfig } from "./credentials.ts";
export { createLifecycleCleanup, issueRestrictedDeletionSession } from "./deletion.ts";
export type { DeletionRequest, DeletionSubject } from "./deletion.ts";
export { uploadAvatar, readAvatar } from "./avatar.ts";
export type { SettingsEffects } from "./sections.ts";
export type { PersonalCalendar } from "./timezones.ts";
export { Refusal } from "./core.ts";

export { withSettingsWrite } from "./core.ts";
