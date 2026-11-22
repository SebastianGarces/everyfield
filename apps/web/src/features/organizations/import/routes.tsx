import { organizationSeatOf } from "@/server/request-context";
import { requireActor } from "@/server/sign-in";
import { loadPipelineBoard } from "../pipeline-mount";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { LANDING_ROUTE } from "@everyfield/contracts/identity";
import { NotAvailable } from "../../access/AccessStates";
import { PIPELINE_PATH } from "../board/model";
import { PipelineImportScreen } from "./ImportScreen";

export const importMetadata: Metadata = { title: "Import people", robots: { index: false, follow: false } };
const PATH = `${PIPELINE_PATH}/import`;

export async function PipelineImportPage() {
	const seat = organizationSeatOf(await requireActor(PATH));
	const board = seat ? await loadPipelineBoard(seat.authority, {}) : null;
	if (board?.status !== "ok" || board.value.audience !== "administrator")
		return (
			<div className="py-12">
				<Card className="mx-auto max-w-[560px]">
					<NotAvailable scope="page" homeHref={LANDING_ROUTE} />
				</Card>
			</div>
		);
	return <PipelineImportScreen stages={board.value.stages} staff={board.value.staff} />;
}
