import { organizationSeatOf } from "@/server/request-context";
import { requireActor } from "@/server/sign-in";
import { pipelinePeopleRead } from "../pipeline-mount";
import { listOrganizationDuplicatePairs } from "@everyfield/domain/people";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { LANDING_ROUTE } from "@everyfield/contracts/identity";
import { NotAvailable } from "../../access/AccessStates";
import { PIPELINE_PATH } from "../board/model";
import { DuplicatesScreen } from "./DuplicatesScreen";

export const duplicatesMetadata: Metadata = { title: "Possible duplicates", robots: { index: false, follow: false } };
const PATH = `${PIPELINE_PATH}/duplicates`;

export async function DuplicatesPage() {
	const seat = organizationSeatOf(await requireActor(PATH));
	const pairs = seat ? await pipelinePeopleRead(listOrganizationDuplicatePairs) : null;
	if (pairs?.status !== "ok")
		return (
			<div className="py-12">
				<Card className="mx-auto max-w-[560px]">
					<NotAvailable scope="page" homeHref={LANDING_ROUTE} />
				</Card>
			</div>
		);
	return <DuplicatesScreen pairs={pairs.value} />;
}
