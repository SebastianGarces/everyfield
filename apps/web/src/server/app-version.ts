import { serverEnv } from "./config.ts";
export const appVersion = () => serverEnv().VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
