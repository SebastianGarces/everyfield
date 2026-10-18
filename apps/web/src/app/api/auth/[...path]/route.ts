import { identityHandler } from '@/server/identity';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export { identityHandler as GET, identityHandler as POST, identityHandler as PUT, identityHandler as DELETE, identityHandler as PATCH, identityHandler as HEAD, identityHandler as OPTIONS };
