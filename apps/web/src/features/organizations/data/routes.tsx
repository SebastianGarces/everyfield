import { signIn } from "@/server/sign-in";
import { pipelineActor, pipelinePeopleRead } from "../pipeline-mount";
import { listOrganizationDuplicatePairs } from "@everyfield/domain/people";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { NotAvailable } from "../../access/AccessStates";
import { PIPELINE_PATH } from "../board/model";
import { DuplicatesScreen } from "./DuplicatesScreen";

export const duplicatesMetadata: Metadata = { title: "Possible duplicates", robots: { index: false, follow: false } };
const PATH = `${PIPELINE_PATH}/duplicates`;

export async function DuplicatesPage() {
	const who = await pipelineActor();
	if (who.kind === "signed_out") signIn(PATH);
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
