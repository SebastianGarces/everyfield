import { z } from "zod";
import { accountId, digest, owner, requestKey, revision } from "./values.ts";
export function commandEnvelope<T extends z.ZodType>(input: T) {
	return z.strictObject({ requestKey, expectedRevision: revision, input });
}
export const requestIdentity = z.strictObject({
	owner,
	actorId: accountId,
	operation: z.string().min(1).max(160),
	requestKey,
	digest,
});
export type RequestIdentity = z.infer<typeof requestIdentity>;
