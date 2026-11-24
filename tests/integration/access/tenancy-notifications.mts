import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import {
	getPreferences,
	previewOversightDigest,
	previewPlanterDigest,
	readFeedPage,
} from "../../../packages/domain/src/notifications/index.ts";
import { tenancyCase, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

let notice: string;
export async function seedNotifications(t: Tenancy) {
	notice = randomUUID();
	await t.f.admin
		.execute(sql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,
			source_revision,title,eligible_at,created_at,timezone)
		VALUES(${notice},${t.plantA.id},${t.ownerA.id},'task','task_due',${`${t.plantA.id}/task_due/${notice}`},
			(SELECT id FROM task WHERE plant_id = ${t.plantA.id} ORDER BY created_at LIMIT 1),
			1,${`${t.MARK} notice`},clock_timestamp() - interval '1 minute',clock_timestamp(),'America/Chicago')`);
}

export function notificationsCases(t: Tenancy, who: TenancyOwner) {
	return [
		tenancyCase("notifications:readFeedPage", () => readFeedPage(t.f.db, who.actor, {}), {
			partial: { feed: { items: [] }, unread: 0 },
			control: (value) => assert.equal(value.feed.items[0]!.id, notice),
		}),
		tenancyCase("notifications:getPreferences", () => getPreferences(t.f.db, who.actor), {
			check: (value) => assert.ok(value.revision),
			control: null,
		}),
		tenancyCase(
			"notifications:previewPlanterDigest",
			() => previewPlanterDigest(t.f.db, who.actor, { plantId: t.plantA.id }, () => new Date()),
			{ refused: "access_denied", control: (value) => assert.ok(value.zone) },
		),
		tenancyCase(
			"notifications:previewOversightDigest",
			() => previewOversightDigest(t.f.db, who.actor, { organizationId: t.a.network }, () => new Date()),
			{ refused: "access_denied", control: null },
		),
	];
}
