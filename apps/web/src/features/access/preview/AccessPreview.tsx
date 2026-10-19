"use client";

import { Card, PageHeader, SegmentedControl } from "@everyfield/ui/controls";
import { ShellPreview } from "@everyfield/ui/shell/preview";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { NotAvailable, PendingAccount, SessionEnded } from "../AccessStates";
import { canReadStaffNotes } from "../port";
import { PersonDuties, StaffNotesPanel } from "../StaffNotes";
import {
	accessFor,
	authorName,
	NOTE_SCENARIOS,
	notesReader,
	PERSON,
	SCENARIO_LABEL,
	VIEWER_LABEL,
	VIEWERS,
	ZONE,
	type AccessFlow,
	type NoteScenario,
	type Viewer,
} from "./fixtures";

function pick<T extends string>(all: readonly T[], raw: string | null, fallback: T): T {
	return (all as readonly string[]).includes(raw ?? "") ? (raw as T) : fallback;
}

/**
 * The access boundary previews at /design/access/[flow] (WP-006/ui R8). `staff-notes` takes `as` (viewer duties),
 * `notes` (scenario) and `delay` (fixture latency in ms). `session-ended` takes `returnTo`.
 */
export function AccessPreview({ flow }: { flow: AccessFlow }) {
	const search = useSearchParams();
	if (flow === "session-ended") return <SessionEnded returnTo={search.get("returnTo") ?? "/people?view=core"} />;
	if (flow === "pending") return <PendingAccount />;
	if (flow === "not-available")
		return (
			<ShellPreview role="owner">
				<Card className="mt-6">
					<NotAvailable scope="page" homeHref="/design/shell/owner" />
				</Card>
			</ShellPreview>
		);
	return <StaffNotesPreview />;
}

function StaffNotesPreview() {
	const search = useSearchParams();
	const router = useRouter();
	const pathname = usePathname();
	const viewer = pick(VIEWERS, search.get("as"), "admin");
	const scenario = pick(NOTE_SCENARIOS, search.get("notes"), "pages");
	const wait = Math.min(Math.max(Number(search.get("delay") ?? 500) || 0, 0), 5000);
	const access = accessFor(viewer);
	const read = useMemo(() => notesReader(viewer, scenario, wait), [viewer, scenario, wait]);

	function set(key: string, value: string) {
		const next = new URLSearchParams(search);
		next.set(key, value);
		router.replace(`${pathname}?${next}`, { scroll: false });
	}

	return (
		<div className="min-h-dvh px-10 py-8 max-app-sm:px-4 max-app-sm:py-5">
			<div className="mx-auto flex max-w-[880px] flex-col gap-6">
				<aside
					aria-label="Preview controls"
					className="flex flex-col gap-3 rounded-lg border border-dashed border-line-2 p-4"
				>
					<p className="text-sm text-text-3">
						Design preview with sample data. A program director alone gets no staff notes panel and no hint that notes
						exist.
					</p>
					<div className="flex flex-wrap gap-x-6 gap-y-3">
						<SegmentedControl<Viewer>
							label="Preview as"
							size="sm"
							value={viewer}
							onValueChange={(v) => set("as", v)}
							options={VIEWERS.map((v) => ({ value: v, label: VIEWER_LABEL[v] }))}
						/>
						<SegmentedControl<NoteScenario>
							label="Notes scenario"
							size="sm"
							value={scenario}
							onValueChange={(v) => set("notes", v)}
							options={NOTE_SCENARIOS.map((s) => ({ value: s, label: SCENARIO_LABEL[s] }))}
						/>
					</div>
				</aside>
				<main id="main" className="flex flex-col gap-6">
					<div>
						<PageHeader breadcrumb={[{ label: "Pipeline", href: "#" }, { label: PERSON.name }]} title={PERSON.name} />
						<PersonDuties access={access} personName={PERSON.name} />
					</div>
					{canReadStaffNotes(access) ? (
						<StaffNotesPanel
							key={`${viewer}-${scenario}`}
							personName={PERSON.name}
							read={read}
							authorName={authorName}
							zone={ZONE}
						/>
					) : null}
				</main>
			</div>
		</div>
	);
}
