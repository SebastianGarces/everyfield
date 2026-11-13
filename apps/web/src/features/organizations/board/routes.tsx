import { loadPipelineBoard, loadPipelinePerson, pipelineActor } from "@/server/organizations/pipeline";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NotAvailable } from "../../access/AccessStates";
import { PIPELINE_PATH, queryFromSearch } from "./model";
import { PersonRecord } from "./PersonRecord";
import { PipelineScreen } from "./PipelineScreen";

// The organization Pipeline routes. app/(product)/organization/pipeline/** only re-exports these.

export const pipelineMetadata: Metadata = { title: "Pipeline", robots: { index: false, follow: false } };

type Search = Promise<Record<string, string | string[] | undefined>>;

const refused = (
	<div className="py-12">
		<Card className="mx-auto max-w-[560px]">
			<NotAvailable scope="page" homeHref={PIPELINE_PATH} />
		</Card>
	</div>
);

export async function PipelinePage({ searchParams }: { searchParams: Search }) {
	const who = await pipelineActor();
	if (who.kind === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(PIPELINE_PATH)}`);
	if (who.kind !== "seat") return refused;
	const board = await loadPipelineBoard(who.authority, queryFromSearch(await searchParams));
	if (board.status !== "ok") return refused;
	return <PipelineScreen initial={board.value} />;
}

export async function PipelinePersonPage({ params }: { params: Promise<{ personId: string }> }) {
	const { personId } = await params;
	const who = await pipelineActor();
	if (who.kind === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(`${PIPELINE_PATH}/${personId}`)}`);
	if (who.kind !== "seat") return refused;
	// The record and the stage list (for a move) and staff (for an edit) need nothing from each other.
	const [record, board] = await Promise.all([
		loadPipelinePerson(who.authority, personId),
		loadPipelineBoard(who.authority, {}),
	]);
	if (record.status !== "ok" || board.status !== "ok") return refused;
	return <PersonRecord initial={record.value} stages={board.value.stages} staff={board.value.staff} />;
}
