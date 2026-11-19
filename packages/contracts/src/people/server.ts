import type { z } from "zod";
import type { accountId, Owner, sessionId, Reply } from "../common/values.ts";
import type { lockedPersonReference } from "./references.ts";
import type * as request from "./requests.ts";
import type * as result from "./results.ts";

export type PeopleContext = {
	session: z.infer<typeof sessionId>;
	selected: Owner;
};
export type PeopleWriteContext = PeopleContext;
export type PeopleReply<T> = Reply<T, z.infer<typeof result.peopleError>>;
export interface PeopleReader<Tx> {
	getPipelineData(
		tx: Tx,
		context: PeopleContext,
		input: z.infer<typeof request.listPeopleRequest>,
	): Promise<PeopleReply<z.infer<typeof result.pipelineResult>>>;
	getStatusWarnings(
		tx: Tx,
		context: PeopleContext,
		input: z.infer<typeof request.personRequest>,
	): Promise<PeopleReply<z.infer<typeof result.statusWarningsResult>>>;
	getPerson(
		tx: Tx,
		context: PeopleContext,
		input: z.infer<typeof request.personRequest>,
	): Promise<PeopleReply<z.infer<typeof result.personResult>>>;
	listPeople(
		tx: Tx,
		context: PeopleContext,
		input: z.infer<typeof request.listPeopleRequest>,
	): Promise<PeopleReply<z.infer<typeof result.peoplePage>>>;
	getActivities(
		tx: Tx,
		context: PeopleContext,
		input: z.infer<typeof request.activityRequest>,
	): Promise<PeopleReply<z.infer<typeof result.activitiesResult>>>;
	getOwnAccountPerson(
		tx: Tx,
		context: PeopleContext,
		input: z.infer<typeof request.ownAccountPersonRequest>,
	): Promise<PeopleReply<z.infer<typeof result.accountLinkResult>>>;
}
export interface PeopleWriter<Tx, Reminders> {
	addNote(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<PeopleReply<z.infer<typeof result.noteMutationResult>>>;
	editNote(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<PeopleReply<z.infer<typeof result.noteMutationResult>>>;
	deleteNote(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<PeopleReply<z.infer<typeof result.noteMutationResult>>>;
	recordAdultClassification(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
	correctAdultClassification(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
	reorderPipeline(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<
		PeopleReply<{ receiptId: z.infer<typeof import("../common/values.ts").operationId>; outcome: "changed" | "noop" }>
	>;

	createPerson(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
	updatePerson(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
	changeStatus(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
		reminders: Reminders,
	): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
	retirePerson(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
		reminders: Reminders,
	): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
	restorePerson(
		tx: Tx,
		context: PeopleWriteContext,
		input: unknown,
	): Promise<PeopleReply<z.infer<typeof result.plantPersonMutationResult>>>;
}
export interface AccountPersonProducer<Tx> {
	ensureAccountPerson(
		tx: Tx,
		input: {
			accountId: z.infer<typeof accountId>;
			owner: z.infer<typeof import("./values.ts").plantOwner>;
			selection:
				| { kind: "resolve" }
				| { kind: "reviewed_contact"; person: z.infer<typeof lockedPersonReference> }
				| { kind: "create"; displayName: string }
				| { kind: "first"; displayName: string };
		},
	): Promise<PeopleReply<z.infer<typeof result.accountPersonResolution>>>;
}
