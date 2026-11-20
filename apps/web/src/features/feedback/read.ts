import { getViewer } from "@/server/request-context";
import { feedbackCategory, feedbackStatus } from "@everyfield/contracts/feedback";
import "server-only";
import { z } from "zod";
import { defineReads } from "../../server/platform/reads.ts";
import type { DialogContext } from "./actions.ts";
import { appVersion, feedbackWriter, runAs, type Run } from "./server.ts";

export const GET = defineReads(
	async () => ({ viewer: await getViewer() }),
	"signed_out",
	(get) => ({
		context: get(z.undefined(), async ({ viewer }): Promise<Run<DialogContext>> => {
			const r = await runAs(viewer, (db, authority) => feedbackWriter.getSendContext(db, authority));
			return r.status === "ok" ? { status: "ok", value: { ...r.value, appVersion: appVersion() } } : r;
		}),
		own: get(z.strictObject({ cursor: z.string() }), ({ viewer }, v) =>
			runAs(viewer, (db, authority) => feedbackWriter.listOwn(db, authority, v)),
		),
		triage: get(
			z.strictObject({
				status: feedbackStatus.nullable(),
				category: feedbackCategory.nullable(),
				cursor: z.string(),
			}),
			({ viewer }, filter) => runAs(viewer, (db, authority) => feedbackWriter["admin.list"](db, authority, filter)),
		),
	}),
);
