import { pipelineActor } from "@/server/organizations/pipeline";
import { loadEnrollment, loadProgram, loadPrograms } from "@/server/organizations/programs";
import { Card } from "@everyfield/ui/controls";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { NotAvailable } from "../../access/AccessStates";
import { EnrollmentScreen } from "./EnrollmentScreen";
import { enrollmentHref, programHref, PROGRAMS_PATH } from "./model";
import { NewProgram } from "./NewProgram";
import { ProgramScreen } from "./ProgramScreen";
import { ProgramsScreen } from "./ProgramsScreen";

// The Programs tab of the organization Pipeline and its program and enrollment routes.
// app/(product)/organization/pipeline/programs/** only re-exports these.

export const programsMetadata: Metadata = { title: "Programs", robots: { index: false, follow: false } };

const refused = (
	<div className="py-12">
		<Card className="mx-auto max-w-[560px]">
			<NotAvailable scope="page" homeHref={PROGRAMS_PATH} />
		</Card>
	</div>
);

/** The request's organization seat, or a redirect to sign in that comes back to `path`. */
async function seat(path: string) {
	const who = await pipelineActor();
	if (who.kind === "signed_out") redirect(`/signin?returnTo=${encodeURIComponent(path)}`);
	return who.kind === "seat" ? who.authority : null;
}

export async function ProgramsPage() {
	const authority = await seat(PROGRAMS_PATH);
	if (!authority) return refused;
	const list = await loadPrograms(authority);
	if (list.status !== "ok") return refused;
	return <ProgramsScreen list={list.value} />;
}

export async function NewProgramPage() {
	const authority = await seat(`${PROGRAMS_PATH}/new`);
	if (!authority) return refused;
	const list = await loadPrograms(authority);
	if (list.status !== "ok" || !list.value.administrator) return refused;
	return <NewProgram list={list.value} />;
}

export async function ProgramPage({ params }: { params: Promise<{ programId: string }> }) {
	const { programId } = await params;
	const authority = await seat(programHref(programId));
	if (!authority) return refused;
	const program = await loadProgram(authority, programId);
	if (program.status !== "ok") return refused;
	return <ProgramScreen initial={program.value} organizationId={authority.actor.context.owner.id} />;
}

export async function EnrollmentPage({ params }: { params: Promise<{ enrollmentId: string }> }) {
	const { enrollmentId } = await params;
	const authority = await seat(enrollmentHref(enrollmentId));
	if (!authority) return refused;
	const enrollment = await loadEnrollment(authority, enrollmentId);
	if (enrollment.status !== "ok") return refused;
	return <EnrollmentScreen initial={enrollment.value} />;
}
