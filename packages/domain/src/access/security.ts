import "server-only";
export { safeReturn } from "@everyfield/contracts/identity";

// Admission is configured by server adapters. A verifier is an actual producer
// callback, never a boolean or exception kind accepted from the request body.
export interface RequestAdmission {
	origin: string;
	host: string;
	browserMutations: readonly { path: string; methods: readonly string[] }[];
	exceptions?: readonly {
		kind: "resend_raw_signature" | "unsubscribe_disable" | "bounded_job";
		path: string;
		method: "POST";
		verify(request: Request): Promise<boolean>;
	}[];
}
export function requestAdmission(config: RequestAdmission) {
	const canonical = new URL(config.origin);
	if (
		canonical.origin !== config.origin ||
		canonical.host !== config.host ||
		!["https:", "http:"].includes(canonical.protocol)
	)
		throw Error("invalid_canonical_origin");
	const exceptions = new Map(config.exceptions?.map((rule) => [rule.path, rule]));
	if (exceptions.size !== (config.exceptions?.length ?? 0)) throw Error("duplicate_admission_exception");
	return async function checkRequestOrigin(request: Request): Promise<boolean> {
		const url = new URL(request.url);
		if (url.origin !== canonical.origin || request.headers.get("host") !== config.host) return false;
		// No prefix bypass, URL rewrite stamp, crawler header or forwarded host.
		const exception = exceptions.get(url.pathname);
		if (exception && request.method === exception.method) return exception.verify(request.clone());
		const allowed = config.browserMutations.find((rule) => rule.path === url.pathname);
		return (
			!!allowed &&
			["POST", "PUT", "PATCH", "DELETE"].includes(request.method) &&
			allowed.methods.includes(request.method) &&
			request.headers.get("origin") === config.origin
		);
	};
}
