import { createPhaseWriter, phaseReader } from "../../../packages/domain/src/phases/index.ts";
import { tenancyCase, type Tenancy, type TenancyOwner } from "./tenancy-case.mts";

const phases = createPhaseWriter({ notices: async () => {} });

export async function seedPhases(t: Tenancy) {
	const { MARK, key, ok } = t;
	const db = t.f.db;
	const state = async () => ok(await phaseReader.readHistory(db, t.ownerA.actor)).state;
	const joined = await state();
	ok(
		await phases.declare(db, t.ownerA.actor, {
			requestKey: key(),
			expectedRevision: joined.revision,
			input: { phase: joined.phase },
		}),
	);
	ok(
		await phases.transition(db, t.ownerA.actor, {
			requestKey: key(),
			expectedRevision: (await state()).revision,
			input: { toPhase: joined.phase + 1, reason: `${MARK} ready for the next phase` },
		}),
	);
}

export function phasesCases(t: Tenancy, who: TenancyOwner) {
	return [
		tenancyCase("phases:phaseReader.readHistory", () => phaseReader.readHistory(t.f.db, who.actor), {
			value: {
				state: { phase: 1, revision: "1", declarable: true },
				plantName: "Synthetic plant",
				timeZone: "UTC",
				entries: [],
			},
		}),
	];
}
