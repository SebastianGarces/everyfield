import { privateStorage } from "@everyfield/db/schema";
import { readStagedPhoto } from "@everyfield/evry";
import { errorResponse, evryDatabase, requestActor } from "@/server/evry";
import { privateHeaders } from "@/server/platform/boundary";

export const dynamic = "force-dynamic";
// GET /api/evry/proposals/{id}/photo: the upload a set-photo proposal would make the person's photo, for the
// proposal's owner while its review lasts. There is no storage link and nothing is cached: every request checks the
// session, seat, role and review again, so the image stops with the review.
export const GET = async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	try {
		const photo = await readStagedPhoto(evryDatabase(), privateStorage(), await requestActor(), id);
		return new Response(Buffer.from(photo.bytes), {
			headers: { ...privateHeaders, "Content-Type": photo.mediaType, "Content-Length": String(photo.bytes.length) },
		});
	} catch (error) {
		return errorResponse(error);
	}
};
