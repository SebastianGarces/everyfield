import type { Database, Transaction } from "@everyfield/db/client";
import type { SQL } from "@everyfield/db/query";
import type { RequestActor } from "@everyfield/domain/access";
import type { createInvitationService } from "@everyfield/domain/identity";
import type { OnboardingProducer } from "@everyfield/contracts/onboarding/server";
import type { OrganizationAdapter } from "@everyfield/contracts/organizations";
import type { DeletionProducer, NativeAccountProducer, SettingsProducer } from "@everyfield/contracts/settings/server";
import type { DeliveryKeys, DeliveryTransport } from "@everyfield/domain/communication";
import type { MailReport } from "@everyfield/contracts/communication";
import type { PeopleContext } from "@everyfield/contracts/people";
import type { PhaseNotices } from "@everyfield/domain/phases";
import type { LaunchNotices } from "@everyfield/domain/launch";
import type { TaskReminders } from "@everyfield/domain/tasks";
import { z } from "zod";
import type { EvryActor } from "../context/actor.ts";
import type { ConversationFiles } from "../catalog/types.ts";

export type MailPort = { transport: DeliveryTransport; keys: DeliveryKeys };

export type EffectPorts = { reminders: TaskReminders; phaseNotices: PhaseNotices };

export type NativePorts = {
	invitations(
		db: Database | Transaction,
	): Pick<ReturnType<typeof createInvitationService>, "invite" | "resend" | "revoke" | "list">;
	organizations: OrganizationAdapter<Transaction>;
	settings: Pick<
		SettingsProducer<Transaction>,
		"updatePlantProfile" | "setDigestSchedule" | "previewPlantTimezone" | "setPlantTimezone"
	>;
	account: Pick<NativeAccountProducer<Transaction>, "finalizeAvatar"> &
		Pick<DeletionProducer<Transaction>, "requestAccountDeletion">;
	onboarding: OnboardingProducer<Transaction>;
	appVersion: string | null;
	launchNotices?: LaunchNotices;
};

export type ReviewContext = {
	db: Database;
	mail: MailPort | null;
	native: NativePorts | null;
	conversationId: string | null;
	files?: ConversationFiles | null;
};

export type NativeContext = { authority: RequestActor; ports: NativePorts | null };

export const personOutcome = z.object({
	id: z.uuid(),
	label: z.string(),
	outcome: z.enum(["changed", "unchanged"]),
	reason: z.string().optional(),
});
export const importOutcome = z.object({
	status: z.enum(["in_progress", "complete", "partial"]),
	counts: z.object({ created: z.int(), skipped: z.int(), failed: z.int(), remaining: z.int() }),
	failed: z.array(z.object({ row: z.int(), reason: z.string() })),
});
export const currentPerson = z.object({ id: z.uuid(), label: z.string(), value: z.string().nullable() });
type EffectDone = {
	receiptId?: string;
	revision: string;
	report?: MailReport;
	people?: z.infer<typeof personOutcome>[];
	import?: z.infer<typeof importOutcome>;
};
type OwnSettingsDone = { own: true };
export type EffectResult = EffectDone | OwnSettingsDone | { refused: string };

export type ReviewedWrite<I> = {
	operation: string;
	description: string;
	input: z.ZodType<I>;
	allowed(actor: EvryActor): boolean;
	review(actor: EvryActor, input: I, context: ReviewContext): SQL | Promise<SQL | null>;
	execute(
		tx: Transaction,
		context: PeopleContext,
		args: unknown,
		effectKey: string,
		ports: EffectPorts,
		native: NativeContext,
	): Promise<EffectResult>;
	approveNow?: {
		reason: boolean;
		run(db: Database, authority: RequestActor, args: unknown, reason: string | null): Promise<EffectResult>;
	};
	recheck?(tx: Transaction, context: PeopleContext, args: unknown): Promise<string | null>;
	current?(p: SQL): SQL;
	reach?(
		db: Database,
		authority: RequestActor,
		args: unknown,
		effectKey: string,
		first: EffectDone,
		mail: MailPort,
	): Promise<EffectResult>;
	check?(
		db: Database,
		authority: RequestActor,
		args: unknown,
		keys: { effectKey: string; checkKey: string; revision: string },
		mail: MailPort,
	): Promise<EffectResult>;
};
