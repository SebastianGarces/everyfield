import { executorHandler } from '../../apps/web/src/server/jobs/http.ts';
import { mailCallbackHandler } from '../../apps/web/src/server/jobs/webhook.ts';
import { liveness } from '../../packages/domain/src/operations/health.ts';
import { safeResponse } from '../../apps/web/src/server/platform/boundary.ts';

// Trusted composition only, never a client-supplied registry. Feature owners supply
// their current source authorizers and publishers. Empty registries stay disabled.
export function mountExecutor(config: Parameters<typeof executorHandler>[0] | null) {
  if (!config || !Object.keys(config.handlers).length) return async () => safeResponse({ code: 'unavailable' }, 404);
  return executorHandler(config);
}
export function mountCallback(config: { db: Parameters<typeof mailCallbackHandler>[0]; secret: string } | null) {
  if (!config || config.secret.length < 32) return async () => safeResponse({ code: 'unavailable' }, 404);
  return mailCallbackHandler(config.db, config.secret);
}
export function healthResponse() { return safeResponse(liveness()); }
