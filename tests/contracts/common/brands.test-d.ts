import type { z } from "../../../packages/contracts/node_modules/zod/index.cjs";
import { defineSafeError } from "../../../packages/contracts/src/common/index.ts";
import type { accountId, personId, LocalDate, Instant } from "../../../packages/contracts/src/common/index.ts";
import type { CommandScope } from "../../../packages/contracts/src/common/scope.ts";

export function distinctValues(account: z.infer<typeof accountId>, day: LocalDate) {
  // @ts-expect-error An account identity cannot become a CRM Person identity.
  const person: z.infer<typeof personId> = account;
  // @ts-expect-error A local date cannot be compared as a resolved UTC deadline.
  const deadline: Instant = day;
  // @ts-expect-error JSON-shaped authority does not construct a trusted scope.
  const scope: CommandScope = { actor: { kind: "human", accountId: account }, owner: { kind: "account", id: account }, role: null };
  return { person, deadline, scope };
}

export function refuseDynamicCode(code: string) {
  // @ts-expect-error Error definitions require literal codes, not arbitrary strings.
  return defineSafeError(code, {}, "never");
}
