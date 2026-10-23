import { mailCallbackHandler } from '../../apps/web/src/server/jobs/webhook.ts';
import { liveness } from '../../packages/domain/src/operations/health.ts';
import { safeResponse } from '../../apps/web/src/server/platform/boundary.ts';

// Trusted composition only. A mount without its configuration stays disabled.
export function mountCallback(config: { db: Parameters<typeof mailCallbackHandler>[0]; secret: string } | null) {
  if (!config || config.secret.length < 32) return async () => safeResponse({ code: 'unavailable' }, 404);
  return mailCallbackHandler(config.db, config.secret);
}
export function healthResponse() { return safeResponse(liveness()); }
