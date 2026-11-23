import { organizationSeatOf } from "@/server/request-context";
import { requireActor } from "@/server/sign-in";
import { loadPipelineBoard, loadPipelineChoices, loadPipelineGoals, loadPipelinePerson } from "../pipeline-mount";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { LANDING_ROUTE } from "@everyfield/contracts/identity";
import { NotAvailable } from "../../access/AccessStates";
import { PIPELINE_PATH, queryFromSearch } from "./model";
import { PersonRecord } from "./PersonRecord";
import { PipelineScreen } from "./PipelineScreen";

export const pipelineMetadata: Metadata = { title: "Pipeline", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;

const refused = (
	<div className="py-12">
		<Card className="mx-auto max-w-[560px]">
			<NotAvailable scope="page" homeHref={LANDING_ROUTE} />
		</Card>
	</div>
);

export async function PipelinePage({ searchParams }: { searchParams: Search }) {
	const seat = organizationSeatOf(await requireActor(PIPELINE_PATH));
	if (!seat) return refused;
	const [board, goals] = await Promise.all([
		loadPipelineBoard(seat.authority, queryFromSearch(await searchParams)),
		loadPipelineGoals(seat.authority),
	]);
	if (board.status !== "ok") return refused;
	return <PipelineScreen initial={board.value} goals={goals.status === "ok" ? goals.value : null} />;
}

export async function PipelinePersonPage({ params }: { params: Promise<{ personId: string }> }) {
	const { personId } = await params;
	const seat = organizationSeatOf(await requireActor(`${PIPELINE_PATH}/${personId}`));
	if (!seat) return refused;
	const [record, choices] = await Promise.all([
		loadPipelinePerson(seat.authority, personId),
		loadPipelineChoices(seat.authority),
	]);
	if (record.status !== "ok" || choices.status !== "ok") return refused;
	return (
		<PersonRecord
			initial={record.value}
			stages={choices.value.stages}
			staff={choices.value.staff}
			organization={choices.value.organizationName}
		/>
	);
}
