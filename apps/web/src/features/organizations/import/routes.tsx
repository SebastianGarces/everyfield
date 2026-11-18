import { loadPipelineBoard, pipelineActor } from "../pipeline-mount";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NotAvailable } from "../../access/AccessStates";
import { PIPELINE_PATH } from "../board/model";
import { PipelineImportScreen } from "./ImportScreen";

export const importMetadata: Metadata = { title: "Import people", robots: { index: false, follow: false } };
const PATH = `${PIPELINE_PATH}/import`;

export async function PipelineImportPage() {
	const who = await pipelineActor();
	if (who.kind === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(PATH)}`);
	const board = who.kind === "seat" ? await loadPipelineBoard(who.authority, {}) : null;
	if (board?.status !== "ok" || board.value.audience !== "administrator")
		return (
			<div className="py-12">
				<Card className="mx-auto max-w-[560px]">
					<NotAvailable scope="page" homeHref={PIPELINE_PATH} />
				</Card>
			</div>
		);
	return <PipelineImportScreen stages={board.value.stages} staff={board.value.staff} />;
}
