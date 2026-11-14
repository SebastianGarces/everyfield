// The notification reads of INV-tenancy (tenancy.test.mts) that Evry's notification tools call: church A's owner has a
// marked notice, and church B's owner reads their own feed page and settings and asks for church A's digest preview and
// the oversight digest preview of the network church A is connected to.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/src/query.ts";
import {
	getPreferences,
	previewOversightDigest,
	previewPlanterDigest,
	readFeedPage,
} from "../../../packages/domain/src/notifications/index.ts";

let notice;
export async function seedNotifications(t) {
	notice = randomUUID();
	await t.f.admin
		.execute(sql`INSERT INTO notice(id,tenant_id,recipient_id,category,purpose,logical_key,source_record_id,
			source_revision,title,eligible_at,created_at,timezone)
		VALUES(${notice},${t.plantA.id},${t.ownerA.id},'task','task_due',${`${t.plantA.id}/task_due/${notice}`},
			(SELECT id FROM task WHERE plant_id = ${t.plantA.id} ORDER BY created_at LIMIT 1),
			1,${`${t.MARK} notice`},clock_timestamp() - interval '1 minute',clock_timestamp(),'America/Chicago')`);
}

export function notificationsCases(t, who) {
	return [
		[
			"notifications:readFeedPage",
			{
				// It takes no church: only the caller's own notices.
				run: () => readFeedPage(t.f.db, who.actor, {}),
				expected: {
					partial: { feed: { items: [] }, unread: 0 },
					control: (value) => assert.equal(value.feed.items[0].id, notice),
				},
			},
		],
		[
			"notifications:getPreferences",
			{
				// The caller's own settings; church A holds nothing a preference read could show.
				run: () => getPreferences(t.f.db, who.actor),
				expected: { check: (value) => assert.ok(value.revision), control: null },
			},
		],
		[
			"notifications:previewPlanterDigest",
			{
				run: () => previewPlanterDigest(t.f.db, who.actor, { plantId: t.plantA.id }, () => new Date()),
				expected: { refused: "access_denied", control: (value) => assert.ok(value.zone) },
			},
		],
		[
			"notifications:previewOversightDigest",
			{
				// Only the network's own Owner or Admin gets its digest; church A's owner holds no seat there either.
				run: () => previewOversightDigest(t.f.db, who.actor, { organizationId: t.a.network }, () => new Date()),
				expected: { refused: "access_denied", control: null },
			},
		],
	];
}
