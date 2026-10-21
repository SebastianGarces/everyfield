"use client";

import type * as people from "@everyfield/contracts/people";
import type { z } from "zod";
import type { Receipt } from "../boundary.ts";
import type { EntryFields } from "../ActivityCard.tsx";
import type { PersonStore, StageValue } from "../model.ts";
import type { PersonDraft } from "../StageDialog.tsx";
import { AssessmentCard } from "./AssessmentCard.tsx";
import { CommitmentCard } from "./CommitmentCard.tsx";
import { InterviewCard } from "./InterviewCard.tsx";
import type { PersonRecords } from "./model.ts";

export type PlantPerson = z.infer<typeof people.plantPerson>;

/** What each record card needs from the person page. */
export type RecordProps<T> = {
	personId: string;
	personName: string;
	/** The stage as shown now, including a change still saving. */
	stage: StageValue;
	store: PersonStore<PlantPerson, PersonDraft>;
	/** Shows a change to the person (the stage a record advances) while its save runs. */
	expectPerson: (patch: Partial<PlantPerson>) => void;
	/** The first history page, or null when it did not load. */
	initial: T | null;
	canEdit: boolean;
	accountId: string;
	/** A saved record: Activity adds its entry from the receipt. */
	onSaved: (receipt: Receipt, fields: EntryFields) => void;
	/** A refusal because this page's copy of the person is out of date. */
	onConflict: () => void;
	/** A record corrected elsewhere on this page (Correct a record, WP-015): its card shows it as saved now. */
	corrected?: CorrectedRecord | null;
};
export type CorrectedRecord =
	| { type: "assessment"; record: z.infer<typeof people.assessment> }
	| { type: "interview"; record: z.infer<typeof people.interview> }
	| { type: "commitment"; record: z.infer<typeof people.commitment> };

/**
 * The person's 4 C's, interview and commitment (REQ-PPL-012, 013, 014), for an Owner or Admin. The 4 C's and the
 * interview sit side by side as in the approved Person screen; the commitment card is below them.
 */
export function RecordsSection({
	records,
	documentsEnabled,
	...props
}: Omit<RecordProps<never>, "initial"> & { records: PersonRecords; documentsEnabled: boolean }) {
	return (
		<>
			<div className="grid grid-cols-2 items-start gap-5 max-app-sm:grid-cols-1">
				<AssessmentCard {...props} initial={records.assessments} />
				<InterviewCard {...props} initial={records.interviews} />
			</div>
			<CommitmentCard {...props} initial={records.commitments} documentsEnabled={documentsEnabled} />
		</>
	);
}
