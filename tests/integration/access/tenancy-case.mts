import type { SQL } from "../../../packages/db/src/query.ts";
import { S3Client, type PrivateStorage } from "../../../packages/db/src/schema/storage.ts";
import type { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { ok, type Workspace } from "../../support/fixture.mts";
import type { Database } from "../../support/test-database.mts";
import type { fixture, key } from "../identity/invitations-support.mts";

type Reply<V> = { status: "ok"; value: V } | { status: string; error?: { code?: string } };
type Expected<V> = {
	refused?: string;
	value?: unknown;
	partial?: object;
	echo?: readonly string[];
	check?: (value: V) => void;
	control?: ((value: V) => void) | null;
};
export type TenancyCase = [
	name: string,
	read: {
		expected: Expected<never>;
		run(): Promise<{
			reply: { status: string; value?: unknown; error?: { code?: string } };
			check(): void;
			control(): void;
		}>;
	},
];

export function tenancyCase<V>(
	name: string,
	run: () => Promise<Reply<V>>,
	expected: Expected<NoInfer<V>>,
): TenancyCase {
	return [
		name,
		{
			expected,
			async run() {
				const reply = await run();
				return {
					reply,
					check: () => expected.check?.(ok(reply)),
					control: () => expected.control?.(ok(reply)),
				};
			},
		},
	];
}
export const casesFor =
	(prefix: string) =>
	<V,>(name: string, run: () => Promise<Reply<V>>, expected: Expected<NoInfer<V>>) =>
		tenancyCase(prefix + name, run, expected);
export const plain = async <V,>(body: () => V | Promise<V>) => ({ status: "ok" as const, value: await body() });

export type TenancyOwner = Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["account"]>> & {
	actor: RequestActor;
};
export type Seeded = Record<
	| "avery"
	| "blair"
	| "source"
	| "household"
	| "commitment"
	| "merge"
	| "importKey"
	| "team"
	| "meeting"
	| "template"
	| "draft"
	| "sent"
	| "avatar"
	| "brandAsset"
	| "brandSha"
	| "churchDoc"
	| "exportKey"
	| "export"
	| "deletedDoc"
	| "deletedExport"
	| "native"
	| "generated"
	| "venue"
	| "vision"
	| "teamMeeting"
	| "network"
	| "task"
	| "weekly"
	| "ministry"
	| "program",
	string
> & { listedPair: { a: string; b: string }; pair: unknown };
export const rowsOf =
	(admin: () => Database) =>
	async <Row extends Record<string, unknown>>(query: SQL) =>
		(await admin().execute<Row>(query)).rows;
export type Tenancy = {
	f: Awaited<ReturnType<typeof fixture>>;
	a: Seeded;
	MARK: string;
	key: typeof key;
	ok: typeof ok;
	rows: ReturnType<typeof rowsOf>;
	occurredOn: string;
	personA: (name: string, fields?: object) => Promise<{ id: string; revision: string }>;
	storage: PrivateStorage;
	plantA: Workspace;
	ownerA: TenancyOwner;
};

class StubClient extends S3Client {
	answer: (operation: string) => object;
	constructor(answer: (operation: string) => object) {
		super({ region: "us-east-1", credentials: { accessKeyId: "test", secretAccessKey: "test" } });
		this.answer = answer;
	}
	override async send(command: object) {
		return this.answer(command.constructor.name);
	}
}
export const stubStorage = (bucket: string, answer: (operation: string) => object): PrivateStorage => ({
	bucket,
	client: new StubClient(answer),
});
export const seedStorage = (bucket: string) =>
	stubStorage(bucket, (operation) => {
		switch (operation) {
			case "GetBucketAclCommand":
				return { Grants: [{ Grantee: { ID: "private-owner" }, Permission: "FULL_CONTROL" }] };
			case "PutObjectCommand":
				return {};
			default:
				throw Error(`unexpected provider operation ${operation}`);
		}
	});
