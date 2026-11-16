"use client";

import type * as people from "@everyfield/contracts/people";
import type { z } from "zod";
import type { Receipt } from "../boundary.ts";
import type { EntryFields } from "../ActivityCard.tsx";
import type { StageValue } from "../model.ts";
import type { PersonStore } from "../person.store.ts";
import type { PersonDraft } from "../StageDialog.tsx";
import { AssessmentCard } from "./AssessmentCard.tsx";
import { CommitmentCard } from "./CommitmentCard.tsx";
import { InterviewCard } from "./InterviewCard.tsx";
import type { PersonRecords } from "./model.ts";

export type PlantPerson = z.infer<typeof people.plantPerson>;

export type RecordProps<T> = {
	personId: string;
	personName: string;
	stage: StageValue;
	store: PersonStore<PlantPerson, PersonDraft>;
	expectPerson: (patch: Partial<PlantPerson>) => void;
	initial: T | null;
	canEdit: boolean;
	accountId: string;
	onSaved: (receipt: Receipt, fields: EntryFields) => void;
	onConflict: () => void;
	corrected?: readonly CorrectedRecord[];
};
export type CorrectedRecord =
	| { type: "assessment"; record: z.infer<typeof people.assessment> }
	| { type: "interview"; record: z.infer<typeof people.interview> }
	| { type: "commitment"; record: z.infer<typeof people.commitment> };

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
