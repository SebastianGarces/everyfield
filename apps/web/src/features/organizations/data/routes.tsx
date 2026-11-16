import { pipelineActor, pipelinePeopleRead } from "@/server/organizations/pipeline";
import { listOrganizationDuplicatePairs } from "@everyfield/domain/people";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NotAvailable } from "../../access/AccessStates";
import { PIPELINE_PATH } from "../board/model";
import { DuplicatesScreen } from "./DuplicatesScreen";

export const duplicatesMetadata: Metadata = { title: "Possible duplicates", robots: { index: false, follow: false } };
const PATH = `${PIPELINE_PATH}/duplicates`;

export async function DuplicatesPage() {
	const who = await pipelineActor();
	if (who.kind === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(PATH)}`);
	const pairs = who.kind === "seat" ? await pipelinePeopleRead(listOrganizationDuplicatePairs) : null;
	if (pairs?.status !== "ok")
		return (
			<div className="py-12">
				<Card className="mx-auto max-w-[560px]">
					<NotAvailable scope="page" homeHref={PIPELINE_PATH} />
				</Card>
			</div>
		);
	return <DuplicatesScreen pairs={pairs.value} />;
}
