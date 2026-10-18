import 'server-only';
import { isIP } from 'node:net';
// Only the Vercel runtime may trust this overwritten platform header.
// https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for
export function trustedIdentityIp(request: Request, vercelRuntime: boolean): string | null {
  if (!vercelRuntime) return null;
  const value = request.headers.get('x-vercel-forwarded-for');
  return value && isIP(value) ? value : null;
}
