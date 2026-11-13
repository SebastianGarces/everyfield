import { checkProposal } from "@everyfield/evry";
import { evryMail, evryResponse } from "@/server/evry";

export const dynamic = "force-dynamic";
// "Check again" asks the email service, which can take a few seconds per recipient.
export const maxDuration = 60;
export const POST = async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
	const { id } = await params;
	return evryResponse(async (db, actor) => checkProposal(db, actor, id, evryMail()));
};
