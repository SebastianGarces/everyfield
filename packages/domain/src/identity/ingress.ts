import "server-only";
import { isIP } from "node:net";
export function trustedIdentityIp(request: { headers: Pick<Headers, "get"> }, vercelRuntime: boolean): string | null {
	if (!vercelRuntime) return null;
	const value = request.headers.get("x-vercel-forwarded-for");
	return value && isIP(value) ? value : null;
}
