import { expireAccessRequests } from "@everyfield/db";
import { cronRoute } from "../server/platform/cron";
import { serverEnv } from "../server/config.ts";
import { transient } from "../server/platform/transient.ts";

export const accessRetention = (request: Request) =>
	cronRoute(serverEnv().CRON_SECRET, async () => {
		return transient(
			{ component: "access", outcome: "retention_failed" },
			async () => Response.json(await expireAccessRequests()),
			Response.json({ status: "unavailable" }, { status: 503 }),
		);
	})(request);
