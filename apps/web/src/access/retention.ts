import { expireAccessRequests } from "@everyfield/db";
import { cronRoute } from "../server/platform/cron";

export const accessRetention = (request: Request) =>
	cronRoute(process.env.CRON_SECRET, async () => {
		try {
			return Response.json(await expireAccessRequests());
		} catch {
			return Response.json({ status: "unavailable" }, { status: 503 });
		}
	})(request);
