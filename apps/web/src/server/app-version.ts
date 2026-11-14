/**
 * The deployed version, from the host's build, or null when it does not say (a local build). Feedback is saved with it,
 * from the feedback dialog and from Evry (T-330). It has no path aliases, so plain tsx loads it with Evry's native ports.
 */
export const appVersion = () => process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null;
