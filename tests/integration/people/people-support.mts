import assert from "node:assert/strict";
import type {
	activityRequest,
	listPeopleRequest,
	ownAccountPersonRequest,
	personRequest,
} from "../../../packages/contracts/src/people/requests.ts";
import { plantOwner } from "../../../packages/contracts/src/people/values.ts";
import type { PeopleReply } from "../../../packages/contracts/src/people/server.ts";
import { RequestActor, type WriteTx } from "../../../packages/domain/src/access/session.ts";
import type { Context } from "../../../packages/domain/src/people/core.ts";
import { peopleReader } from "../../../packages/domain/src/people/index.ts";
import { S3Client } from "../../../packages/db/src/schema/storage.ts";
import { ok, type Actor } from "../../support/fixture.mts";
import type { Database } from "../../support/test-database.mts";

export type Reply<T> = PeopleReply<T>;
export type Row = Record<string, unknown>;
type Input<S extends { _input: unknown }> = S["_input"];
type Answer<K extends keyof typeof peopleReader> = ReturnType<(typeof peopleReader)[K]>;

interface Reads {
	getPipelineData(tx: WriteTx, context: Context, input: Input<typeof listPeopleRequest>): Answer<"getPipelineData">;
	getStatusWarnings(tx: WriteTx, context: Context, input: Input<typeof personRequest>): Answer<"getStatusWarnings">;
	getPerson(tx: WriteTx, context: Context, input: Input<typeof personRequest>): Answer<"getPerson">;
	listPeople(tx: WriteTx, context: Context, input: Input<typeof listPeopleRequest>): Answer<"listPeople">;
	getActivities(tx: WriteTx, context: Context, input: Input<typeof activityRequest>): Answer<"getActivities">;
	getOwnAccountPerson(
		tx: WriteTx,
		context: Context,
		input: Input<typeof ownAccountPersonRequest>,
	): Answer<"getOwnAccountPerson">;
}
export const reads: Reads = peopleReader;

export const church = (id: string) => plantOwner.parse({ kind: "plant", id });

export async function authorityOf(db: Database | WriteTx, actor: Pick<Actor, "session">) {
	const authority = await RequestActor.resolve(db, actor.session);
	assert.ok(authority instanceof RequestActor);
	return authority;
}

export const noReminders = async (): Promise<never> => {
	throw Error("unexpected task reminder replan");
};

export const has = <T extends { status: string }, S extends string>(
	value: T,
	status: S,
): value is Extract<T, { status: S }> => value.status === status;
export function withStatus<T extends { status: string }, S extends T["status"]>(value: T, status: S) {
	assert.ok(has(value, status), JSON.stringify(value));
	return value;
}
export const okWith = <T extends { status: string }, S extends T["status"]>(reply: Reply<T>, status: S) =>
	withStatus(ok(reply), status);
type Item = Extract<Awaited<Answer<"getActivities">>, { status: "ok" }>["value"]["items"][number];
export function activity(item: Item | undefined) {
	assert.ok(item?.kind === "activity");
	return item;
}
export const actionOf = (item: Item) => activity(item).action;
export const isActivity = (item: Item): item is Extract<Item, { kind: "activity" }> => item.kind === "activity";
export function plantPerson(reply: Awaited<Answer<"getPerson">>) {
	const { person } = okWith(reply, "available");
	assert.ok("commitment" in person);
	return person;
}

type StoredObject = { Key?: string; ACL?: string; Body?: unknown };
export class StubClient extends S3Client {
	answer: (operation: string, input: StoredObject) => Promise<object>;
	constructor(answer: StubClient["answer"]) {
		super({
			region: "auto",
			endpoint: "https://storage.example.test",
			credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
		});
		this.answer = answer;
	}
	override async send(command: { input: StoredObject }) {
		return this.answer(command.constructor.name, command.input);
	}
}

export function memoryStorage() {
	const objects = new Map<string, Buffer>();
	const state = { failPuts: false };
	const client = new StubClient(async (operation, input) => {
		const key = input.Key!;
		switch (operation) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "PutObjectCommand":
				if (state.failPuts) throw Error("synthetic_storage_failure");
				assert.ok(input.Body instanceof Uint8Array);
				objects.set(key, Buffer.from(input.Body));
				return {};
			case "GetObjectCommand": {
				const body = objects.get(key);
				if (!body) throw Error("no such object");
				return { ContentLength: body.length, Body: { transformToByteArray: async () => body } };
			}
			case "DeleteObjectCommand":
				objects.delete(key);
				return {};
			default:
				throw Error("unexpected provider operation");
		}
	});
	return { objects, state, bucket: "synthetic-only", client };
}
