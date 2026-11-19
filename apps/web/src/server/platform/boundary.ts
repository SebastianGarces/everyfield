import "server-only";
import { randomUUID } from "node:crypto";
import { ServerConfigError, serverConfig, serverConfigProblem } from "../config.ts";

export const privateHeaders = {
	"Cache-Control": "private, no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};
export class Refusal extends Error {
	readonly code: "unavailable" | "invalid_input" | "origin_denied" | "conflict" | "rate_limited";
	readonly status: number;
	constructor(code: Refusal["code"], status: number) {
		super(code);
		this.code = code;
		this.status = status;
	}
}
export function safeResponse(body: unknown, status = 200) {
	return Response.json(body, { status, headers: privateHeaders });
}
export async function safeBoundary(body: () => Promise<Response>): Promise<Response> {
	const id = randomUUID();
	try {
		const result = await body();
		result.headers.set("X-Request-Id", id);
		return result;
	} catch (error) {
		const response = safeResponse(
			{ code: error instanceof Refusal ? error.code : "unavailable", requestId: id },
			error instanceof Refusal ? error.status : 503,
		);
		response.headers.set("X-Request-Id", id);
		return response;
	}
}

export const ROUTE_KIND = Symbol.for("everyfield.route-kind");
export type RouteKind = "session" | "token" | "signed";
type Handler<A extends unknown[]> = (request: Request, ...rest: A) => Response | Promise<Response>;
export type Route<A extends unknown[]> = Handler<A> & { readonly [ROUTE_KIND]: RouteKind };

const appOrigin = (request: Request) =>
	new URL(serverConfigProblem() ? request.url : serverConfig().IDENTITY_ORIGIN).origin;

export function sameOriginRequest(request: Request): boolean {
	const site = request.headers.get("sec-fetch-site");
	if (site !== null) return site === "same-origin";
	return request.headers.get("origin") === appOrigin(request);
}

export const configured =
	<A extends unknown[]>(handler: Handler<A>): Handler<A> =>
	async (request, ...rest) => {
		try {
			return await handler(request, ...rest);
		} catch (error) {
			if (!(error instanceof ServerConfigError)) throw error;
			return safeResponse({ code: "unavailable" satisfies Refusal["code"] }, 503);
		}
	};

const marked = <A extends unknown[]>(kind: RouteKind, handler: Handler<A>): Route<A> =>
	Object.defineProperty(configured(handler), ROUTE_KIND, { value: kind }) as Route<A>;

export const mutatingRoute = <A extends unknown[]>(handler: Handler<A>): Route<A> =>
	marked("session", (request: Request, ...rest: A) =>
		sameOriginRequest(request)
			? handler(request, ...rest)
			: safeResponse({ code: "origin_denied" satisfies Refusal["code"] }, 403),
	);

export const tokenRoute = <A extends unknown[]>(handler: Handler<A>): Route<A> => marked("token", handler);

export const signedRoute = <A extends unknown[]>(handler: Handler<A>): Route<A> => marked("signed", handler);
