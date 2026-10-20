import type { z } from "../../../packages/contracts/node_modules/zod/index.cjs";
import type { accountId, Instant, LocalDate, personId } from "../../../packages/contracts/src/common/index.ts";
import { defineSafeError } from "../../../packages/contracts/src/common/index.ts";

export function distinctValues(account: z.infer<typeof accountId>, day: LocalDate) {
	// @ts-expect-error An account identity cannot become a CRM Person identity.
	const person: z.infer<typeof personId> = account;
	// @ts-expect-error A local date cannot be compared as a resolved UTC deadline.
	const deadline: Instant = day;

	return { person, deadline };
}

export function refuseDynamicCode(code: string) {
	// @ts-expect-error Error definitions require literal codes, not arbitrary strings.
	return defineSafeError(code, {}, "never");
}
