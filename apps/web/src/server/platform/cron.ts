import { timingSafeEqual } from "node:crypto";

export function cronRoute(secret: string | undefined, run: (request: Request) => Promise<Response>) {
	return async (request: Request): Promise<Response> => {
		if (!secret) return Response.json({ status: "unavailable" }, { status: 503 });
		const expected = Buffer.from(`Bearer ${secret}`);
		const actual = Buffer.from(request.headers.get("authorization") ?? "");
		if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
			return Response.json({ status: "unauthorized" }, { status: 401 });
		return run(request);
	};
}
