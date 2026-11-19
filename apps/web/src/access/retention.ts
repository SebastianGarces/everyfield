import { expireAccessRequests } from "@everyfield/db";
import { cronRoute } from "../server/platform/cron";
import { serverEnv } from "../server/config.ts";

export const accessRetention = (request: Request) =>
	cronRoute(serverEnv().CRON_SECRET, async () => {
		try {
			return Response.json(await expireAccessRequests());
		} catch {
			return Response.json({ status: "unavailable" }, { status: 503 });
		}
	})(request);
