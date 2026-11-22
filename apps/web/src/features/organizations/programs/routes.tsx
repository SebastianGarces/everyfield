import { organizationSeatOf } from "@/server/request-context";
import { requireActor } from "@/server/sign-in";
import { loadEnrollment, loadProgram, loadPrograms } from "./mount";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { LANDING_ROUTE, type SitePath } from "@everyfield/contracts/identity";
import { NotAvailable } from "../../access/AccessStates";
import { EnrollmentScreen } from "./EnrollmentScreen";
import { enrollmentHref, programHref, PROGRAMS_PATH } from "./model";
import { NewProgram } from "./NewProgram";
import { ProgramScreen } from "./ProgramScreen";
import { ProgramsScreen } from "./ProgramsScreen";

export const programsMetadata: Metadata = { title: "Programs", robots: { index: false, follow: false } };

const refused = (
	<div className="py-12">
		<Card className="mx-auto max-w-[560px]">
			<NotAvailable scope="page" homeHref={LANDING_ROUTE} />
		</Card>
	</div>
);

const seat = async (path: SitePath) => organizationSeatOf(await requireActor(path));

export async function ProgramsPage() {
	const found = await seat(PROGRAMS_PATH);
	if (!found) return refused;
	const list = await loadPrograms(found.authority);
	if (list.status !== "ok") return refused;
	return <ProgramsScreen list={list.value} />;
}

export async function NewProgramPage() {
	const found = await seat(`${PROGRAMS_PATH}/new`);
	if (!found) return refused;
	const list = await loadPrograms(found.authority);
	if (list.status !== "ok" || !list.value.administrator) return refused;
	return <NewProgram list={list.value} />;
}

export async function ProgramPage({ params }: { params: Promise<{ programId: string }> }) {
	const { programId } = await params;
	const found = await seat(programHref(programId));
	if (!found) return refused;
	const program = await loadProgram(found.authority, programId);
	if (program.status !== "ok") return refused;
	return <ProgramScreen initial={program.value} organizationId={found.organization.id} />;
}

export async function EnrollmentPage({ params }: { params: Promise<{ enrollmentId: string }> }) {
	const { enrollmentId } = await params;
	const found = await seat(enrollmentHref(enrollmentId));
	if (!found) return refused;
	const enrollment = await loadEnrollment(found.authority, enrollmentId);
	if (enrollment.status !== "ok") return refused;
	return <EnrollmentScreen initial={enrollment.value} />;
}
