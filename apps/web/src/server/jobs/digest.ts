import "server-only";
import type { PoolClient } from "pg";
import { z } from "zod";
import { owedPeriod } from "./calendar.ts";
import { createMailService } from "./mail.ts";
import { channelEnabled } from "./notifications.ts";
const line = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("task"), id: z.uuid(), date: z.iso.date(), title: z.string().min(1).max(500) }),
	z.strictObject({ kind: z.literal("meeting"), id: z.uuid(), date: z.iso.date(), title: z.string().min(1).max(500) }),
	z.strictObject({ kind: z.literal("activity"), date: z.iso.date(), count: z.number().int().nonnegative() }),
]);
const page = z.strictObject({ lines: z.array(line).max(100), total: z.number().int().nonnegative() });
const scope = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("plant"), id: z.uuid() }),
	z.strictObject({
		kind: z.literal("organization"),
		id: z.uuid(),
		organizationKind: z.enum(["sending_church", "sending_network"]),
	}),
]);
export type DigestScope = z.infer<typeof scope>;
export type DigestPage = z.infer<typeof page>;
export function createDigestService(config: {
	origin: string;
	nativePath: (owner: DigestScope) => string;
	mail: ReturnType<typeof createMailService>;
	eligible: (
		tx: PoolClient,
		owner: DigestScope,
		recipient: string,
	) => Promise<{ address: string; cadence: "daily" | "weekly" } | null>;
	load: (
		tx: PoolClient,
		owner: DigestScope,
		recipient: string,
		interval: { start: string; end: string; next: string },
	) => Promise<DigestPage>;
}) {
	const origin = new URL(config.origin).origin;
	async function generateOwed(tx: PoolClient, owner: DigestScope, recipient: string, asOf: string) {
		const o = scope.parse(owner);
		z.uuid().parse(recipient);
		z.iso.datetime().parse(asOf);
		const eligible = await config.eligible(tx, o, recipient);
		if (!eligible) return { kind: "ineligible" } as const;
		const purpose = o.kind === "plant" ? "planter" : "oversight";
		const settings = await tx.query(
			o.kind === "plant"
				? "SELECT timezone,digest_weekday AS weekday,digest_hour AS hour FROM plant WHERE id=$1 FOR SHARE"
				: "SELECT timezone,kind FROM organization WHERE id=$1 FOR SHARE",
			[o.id],
		);
		const setting = settings.rows[0];
		if (!setting || (o.kind === "organization" && setting.kind !== o.organizationKind))
			throw Error("digest_owner_mismatch");
		const zone = z.string().parse(setting.timezone ?? "UTC");
		await tx.query(
			`INSERT INTO digest_coverage(tenant_id,recipient_id,purpose,cadence,timezone)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,recipient_id,purpose) DO NOTHING`,
			[o.id, recipient, purpose, eligible.cadence, zone],
		);
		const result = await tx.query(
			`SELECT id,covered_through::text FROM digest_coverage WHERE tenant_id=$1 AND recipient_id=$2 AND purpose=$3 FOR UPDATE`,
			[o.id, recipient, purpose],
		);
		const coverage = z.object({ id: z.uuid(), covered_through: z.string().nullable() }).parse(result.rows[0]);
		const interval = owedPeriod(
			{
				zone,
				cadence: eligible.cadence,
				completedDaysOnly: o.kind === "organization",
				weekday: o.kind === "plant" ? z.number().int().min(0).max(6).parse(setting.weekday) : 0,
				hour: o.kind === "plant" ? z.number().int().min(0).max(23).parse(setting.hour) : 0,
			},
			asOf,
			coverage.covered_through,
		);
		if (!interval) return { kind: "covered" } as const;
		const input = page.parse(await config.load(tx, o, recipient, interval));
		if (input.total < input.lines.length || (input.total > 0 && input.lines.length === 0))
			throw Error("digest_page_incoherent");
		if (o.kind === "organization" && input.lines.some((l) => l.kind !== "activity"))
			throw Error("digest_projection_denied");
		if (input.total === 0) return { kind: "empty" } as const;
		if (!(await channelEnabled(tx, recipient, `${purpose}_digest`, "email"))) return { kind: "disabled" } as const;
		const title = `${purpose === "planter" ? "Open items" : "Activity"}: ${interval.start} to ${interval.end}`;
		const native = new URL(config.nativePath(o), origin);
		if (native.origin !== origin) throw Error("digest_link_denied");
		const body = [
			title,
			...input.lines.map((l) => (l.kind === "activity" ? `${l.date}: ${l.count} activities` : `${l.date}: ${l.title}`)),
			`Total: ${input.total}. Showing ${input.lines.length}.`,
			input.total > input.lines.length ? `Open EveryField for the remaining items: ${native.href}` : "",
		]
			.filter(Boolean)
			.join("\n");
		const mail = await config.mail.enqueue(tx, {
			owner: o,
			recipient,
			address: eligible.address,
			purpose: `${purpose}_digest`,
			logicalKey: `digest/${recipient}/${purpose}/${zone}/${interval.start}/${interval.end}`,
			operation: null,
			notice: null,
			eligibleAt: asOf,
			content: { subject: title, text: body },
		});
		// A failed intent/receipt rolls back coverage. Retried compilation returns the same identity.
		await tx.query(
			`UPDATE digest_coverage SET covered_through=$2,last_mail_id=$3,cadence=$4,timezone=$5,revision=revision+1 WHERE id=$1`,
			[coverage.id, interval.end, mail, eligible.cadence, zone],
		);
		return {
			kind: "intended",
			mail,
			start: interval.start,
			end: interval.end,
			total: input.total,
			shown: input.lines.length,
		} as const;
	}
	return { generateOwed };
}
