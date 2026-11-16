import { privateStorage } from "@everyfield/db/schema";
import { readStagedPhoto } from "@everyfield/evry";
import { errorResponse, evryDatabase, requestActor } from "@/server/evry";
import { privateHeaders } from "@/server/platform/boundary";

export const dynamic = "force-dynamic";
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
