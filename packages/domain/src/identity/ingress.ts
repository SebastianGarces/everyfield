import "server-only";
import { isIP } from "node:net";
// Only the Vercel runtime may trust this overwritten platform header. It must hold exactly one address, or the IP is
// unknown. A Request fits, and so does `{ headers: await headers() }` in a server action (early access).
// https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
export function trustedIdentityIp(request: { headers: Pick<Headers, "get"> }, vercelRuntime: boolean): string | null {
	if (!vercelRuntime) return null;
	const value = request.headers.get("x-vercel-forwarded-for");
	return value && isIP(value) ? value : null;
}
