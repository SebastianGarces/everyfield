import { deletionCookieValue } from "../../packages/domain/src/proofs.ts";

type Minted = Parameters<typeof deletionCookieValue>;

export const openedDeletion = async (
	session: { handle: Minted[0] } | PromiseLike<{ handle: Minted[0] }>,
	request: { subject: unknown; requestId: string },
) => ({
	kind: "restricted_deletion" as const,
	handle: JSON.parse(deletionCookieValue((await session).handle, request as Minted[1])).handle,
});
