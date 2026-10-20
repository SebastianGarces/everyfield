import "server-only";
import { owner, type Owner } from "@everyfield/contracts/common";
import { settingsError, type SettingsError } from "@everyfield/contracts/settings";
import type { SettingsReply } from "@everyfield/contracts/settings/server";
import type { Transaction } from "@everyfield/db/client";
import { and, eq, isNull } from "@everyfield/db/query";
import * as t from "@everyfield/db/tables";
import type { RequestActor } from "@everyfield/domain/access";
import { sectionOperations, timezoneOperations, withSettingsWrite } from "@everyfield/domain/settings";
import { createHmac, randomUUID } from "node:crypto";
import type { z } from "zod";
import { enqueueJob } from "@/server/jobs/queue";
import { current as organizationMount } from "@/server/organizations";
import { getViewer } from "@/server/request-context";
import type { SettingsViewer } from "./port";

// The settings mount (WP-010): the one door from the settings server actions to the settings domain. The session and
// actor come from the request's getViewer; every write binds that actor in its own transaction (withSettingsWrite)
// and the domain checks authority again. Changes queue their jobs in the same transaction; a worker acts on them.

type Viewer = NonNullable<Awaited<ReturnType<typeof getViewer>>>;
type Signed = { authority: RequestActor; accountId: string };
type Mount = NonNullable<ReturnType<typeof create>>;
type Context = { session: RequestActor["session"]; selected: Owner };

let mount: ReturnType<typeof create> | undefined;
function create(addressKey: Buffer) {
	const organizations = organizationMount();
	if (!organizations) return null;
	const db = organizations.db;
	const effects = {
		// A plant's digest schedule or time zone changed: the digest job plans the next sends again.
		replan: (tx: Transaction, i: { owner: Owner; revision: string; operationId: string; kind: string }) =>
			enqueueJob(tx, {
				tenant: i.owner.id,
				kind: "digest",
				subject: i.owner.id,
				key: `settings/${i.kind}/${i.operationId}`,
				revision: i.revision,
				eligibleAt: new Date().toISOString(),
			}),
		// A material plant fact changed: assessments that read the old value are computed again.
		invalidate: async (tx: Transaction, i: { owner: Owner; revision: string; operationId: string }) => {
			await enqueueJob(tx, {
				tenant: i.owner.id,
				kind: "assessment",
				subject: i.owner.id,
				key: `settings/${i.operationId}`,
				revision: i.revision,
				eligibleAt: new Date().toISOString(),
			});
		},
	};
	const sections = sectionOperations({
		organizations: organizations.adapter,
		organizationEffects: organizations.effects,
		effects,
		// The mail worker's suppression list, keyed the same way: HMAC of the trimmed, lower-case address.
		async suppression(tx, email) {
			const hash = createHmac("sha256", addressKey).update(email.trim().toLowerCase()).digest("hex");
			const rows = await tx
				.select({ id: t.suppression.id })
				.from(t.suppression)
				.where(and(eq(t.suppression.address_hash, hash), isNull(t.suppression.cleared_at)))
				.limit(1);
			return rows.length ? "suppressed" : "clear";
		},
	});
	return { db, sections, timezones: timezoneOperations(effects) };
}
function settingsMount() {
	const key = process.env.IDENTITY_ADDRESS_KEY;
	if (!key || !/^[a-f0-9]{64}$/.test(key)) return null;
	mount ??= create(Buffer.from(key, "hex"));
	return mount;
}

/** What the settings screens need to know about the viewer; null when signed out or without an active actor. */
export function settingsViewerOf(v: Viewer | null): SettingsViewer | null {
	const authority = v?.authority;
	if (!authority || v.status !== "active") return null;
	const context = authority.actor.context;
	if (context.kind !== "seat") return { context: "account", accountId: v.accountId };
	if (context.owner.kind === "plant")
		return { context: "plant", accountId: v.accountId, plant: context.owner, role: context.role };
	return { context: "organization", accountId: v.accountId, organization: context.owner, role: context.role };
}

const RETRY = {
	access_denied: "never",
	invalid_input: "never",
	temporary: "same_request",
	unknown: "reconcile",
} as const;
function refusal(code: keyof typeof RETRY): { status: "refused"; error: SettingsError } {
	return {
		status: "refused",
		error: settingsError.parse({ code, details: {}, correlationId: randomUUID(), retry: RETRY[code] }),
	};
}

/**
 * Runs one settings operation for this request's viewer. The raw browser input is parsed with the contract `schema`
 * first; a request it refuses never reaches the database. `ownerOf` names the section: your account and
 * notifications belong to your account, every other section to the plant or organization of your seat. A write binds
 * the actor in its transaction; a read uses one plain transaction. A thrown error is logged and reads as temporary
 * (read) or unknown (write): the screen then offers to load the latest value.
 */
export async function run<S extends z.ZodType, T>(
	use: "read" | "write",
	schema: S,
	raw: unknown,
	section: (input: z.output<S>) => string,
	operation: (ops: Mount, tx: Transaction, context: Context, input: z.output<S>) => Promise<SettingsReply<T>>,
): Promise<SettingsReply<T>> {
	const viewer = await signedIn();
	const ops = settingsMount();
	if (!viewer || !ops) return refusal("access_denied");
	const input = schema.safeParse(raw);
	if (!input.success) return refusal("invalid_input");
	const self = ["account", "notifications"].includes(section(input.data));
	const selected = self ? owner.parse({ kind: "account", id: viewer.accountId }) : viewer.authority.actor.context.owner;
	const context = { session: viewer.authority.session, selected };
	try {
		return use === "write"
			? await withSettingsWrite(ops.db, viewer.authority, context, (tx) => operation(ops, tx, context, input.data))
			: await ops.db.transaction((tx) => operation(ops, tx, context, input.data));
	} catch (error) {
		console.error(JSON.stringify({ component: "settings", outcome: `${use}_failed`, error: String(error) }));
		return refusal(use === "write" ? "unknown" : "temporary");
	}
}

async function signedIn(): Promise<Signed | null> {
	const v = await getViewer();
	return v?.status === "active" && v.authority ? { authority: v.authority, accountId: v.accountId } : null;
}
