export function liveness(now = new Date()) {
	return { status: "ok" as const, time: now.toISOString() };
}
