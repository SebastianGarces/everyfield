import { z } from 'zod';
export function liveness(now = new Date()) { return { status: 'ok' as const, time: now.toISOString() }; }
export const dependencyNames = ['database', 'objects', 'mail', 'callbacks', 'jobs', 'references', 'backup'] as const;
export type Dependency = typeof dependencyNames[number];
export const dependencyResult = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('ready') }),
  z.strictObject({ status: z.enum(['unconfigured', 'unverified', 'unavailable', 'behind']) }),
]);
export type DependencyResult = z.infer<typeof dependencyResult>;
// The restricted operator adapter establishes current purpose/scope before calling probes.
export async function readiness(probes: Record<Dependency, () => Promise<DependencyResult>>, timeoutMs = 1000) {
  z.number().int().min(1).max(2000).parse(timeoutMs);
  const values = await Promise.all(dependencyNames.map(async name => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<DependencyResult>(resolve => { timer = setTimeout(() => resolve({ status: 'unavailable' }), timeoutMs); });
      const result = await Promise.race([Promise.resolve().then(probes[name]), deadline]);
      return { name, ...dependencyResult.parse(result) };
    } catch { return { name, status: 'unavailable' as const }; }
    finally { if (timer) clearTimeout(timer); }
  }));
  return { status: values.every(v => v.status === 'ready') ? 'ready' as const : 'not_ready' as const, dependencies: values };
}
