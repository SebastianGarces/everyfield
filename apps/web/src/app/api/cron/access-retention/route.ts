import { timingSafeEqual } from "node:crypto";
import { expireAccessRequests } from "@everyfield/db";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ status: "unavailable" }, { status: 503 });
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ status: "unauthorized" }, { status: 401 });
  }
  try {
    return Response.json(await expireAccessRequests());
  } catch {
    return Response.json({ status: "unavailable" }, { status: 503 });
  }
}
