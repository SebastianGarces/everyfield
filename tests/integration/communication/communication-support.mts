import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mock } from "node:test";
import type { SQL } from "../../../packages/db/src/query.ts";
import type { Database } from "../../../packages/db/src/client.ts";
import type { RequestActor, WriteTx } from "../../../packages/domain/src/access/session.ts";
import {
	communicationWriter,
	withCommunicationWrite,
	type CommunicationContext,
	type CommunicationReply,
	type DeliveryKeys,
	type DeliveryTransport,
} from "../../../packages/domain/src/communication/index.ts";
import { gatedTransaction } from "../../../packages/domain/src/operations/writes.ts";
import type { fixture } from "../identity/invitations-support.mts";

export type Fixture = Awaited<ReturnType<typeof fixture>>;
export type Church = Awaited<ReturnType<Fixture["workspace"]>>;
export type Account = Awaited<ReturnType<Fixture["account"]>>;
export type Staff = Account & { actor: RequestActor };
export type Row = Record<string, unknown>;

type Writer = typeof communicationWriter;
type OpsTaking<Head extends unknown[]> = {
	[K in keyof Writer]: Parameters<Writer[K]> extends [...Head, ...unknown[]] ? K : never;
}[keyof Writer];
export type WriteOp = OpsTaking<[WriteTx, CommunicationContext, unknown]>;
export type ReadOp = Exclude<OpsTaking<[WriteTx, RequestActor]>, "listForSelf">;
export type DeliveryOp = "dispatchAttempt" | "sendReviewed" | "handOffScheduled" | "reconcileProviderOutcome";

export type Value<K extends keyof Writer> = Extract<Awaited<ReturnType<Writer[K]>>, { status: "ok" }>["value"];
export type Rest<K extends ReadOp> = Parameters<Writer[K]> extends [WriteTx, RequestActor, ...infer R] ? R : never;

const writes: {
	[K in WriteOp]: (tx: WriteTx, context: CommunicationContext, raw: unknown) => Promise<CommunicationReply<Value<K>>>;
} = communicationWriter;
const reads: {
	[K in ReadOp]: (tx: WriteTx, authority: RequestActor, ...rest: Rest<K>) => Promise<CommunicationReply<Value<K>>>;
} = communicationWriter;
const deliveries: {
	[K in DeliveryOp]: (
		db: Database,
		authority: RequestActor,
		raw: unknown,
		transport: DeliveryTransport,
		keys: DeliveryKeys,
	) => Promise<CommunicationReply<Value<K>>>;
} = communicationWriter;

export const writeAs = <K extends WriteOp>(db: Database, actor: RequestActor, op: K, input: unknown) =>
	withCommunicationWrite(db, actor, (tx, context) => writes[op](tx, context, input));
export const readAs = <K extends ReadOp>(db: Database, actor: RequestActor, op: K, ...rest: Rest<K>) =>
	gatedTransaction(db, (tx) => reads[op](tx, actor, ...rest));
export const deliverAs = <K extends DeliveryOp>(
	db: Database,
	actor: RequestActor,
	op: K,
	input: unknown,
	transport: DeliveryTransport,
	keys: DeliveryKeys,
) => deliveries[op](db, actor, input, transport, keys);

export const rowsFrom = async <R extends Row>(f: Pick<Fixture, "admin">, query: SQL) =>
	(await f.admin.execute<R>(query)).rows;
export function firstRow<T>(list: readonly T[]): T {
	const [value] = list;
	assert.ok(value !== undefined);
	return value;
}

export function sendOnly(send: DeliveryTransport["send"]): DeliveryTransport {
	const unused = async () => {
		throw new Error("unexpected provider call");
	};
	return { send, cancel: unused, reschedule: unused, paused: false };
}

type AcceptanceCase = {
	id: string;
	given: Record<string, Record<string, unknown>>;
	clock: { now: string };
	action: { arguments: Record<string, unknown> };
	expected: { result: Record<string, unknown>; event: null };
	subcases?: (Pick<AcceptanceCase, "action" | "expected"> & { name: string })[];
};
const { cases } = JSON.parse(
	readFileSync(new URL("../../../docs/acceptance/communications-notifications.json", import.meta.url), "utf8"),
) as { cases: AcceptanceCase[] };
export const caseOf = (id: string) => cases.find((c) => c.id === id) ?? assert.fail(`no case ${id}`);

export function pinnedDate(instant: string): Date {
	mock.timers.enable({ apis: ["Date"], now: Date.parse(instant) });
	return new Date(instant);
}
