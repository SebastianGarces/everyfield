import { createRequire } from "node:module";
export const requireApp = createRequire(new URL("../../../apps/web/package.json", import.meta.url));
import {createDatabase} from "../../../packages/db/src/client.ts";
export const owners = { p: "11111111-1111-4111-8111-111111111111", q: "22222222-2222-4222-8222-222222222222" };
export const subjectId = "33333333-3333-4333-8333-333333333333";
export function devPool(url, extra = {}) {
  const host = new URL(url).hostname;
  if (!["ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech", "ep-autumn-dew-b8ltidky-pooler.c-14.us-east-1.aws.neon.tech"].includes(host)) throw new Error("Only approved shared development database allowed");
  return createDatabase({ connectionString: url, options: new URL(url).searchParams.get("options") ?? "-c search_path=wp003_proof", max: 3, connectionTimeoutMillis: 5000, ...extra });
}
