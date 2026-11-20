import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
	answerLeadRequest,
	completeOnboardingRequest,
	declareJourneyRequest,
} from "../../../packages/contracts/src/onboarding/requests.ts";

const plant = { kind: "plant", id: randomUUID() };
const envelope = (input: object) => ({ requestKey: "setup-1", expectedRevision: "1", input });
const setup = [
	{
		name: "declareJourney",
		schema: declareJourneyRequest,
		input: { journey: { answer: "skip" }, launch: { answer: "skip" } },
	},
	{ name: "answerLead", schema: answerLeadRequest, input: { answer: "no" } },
	{ name: "complete", schema: completeOnboardingRequest, input: {} },
];

test("INV-onboarding-authority: a setup command request carries no plant, at the envelope or the input", () => {
	for (const { name, schema, input } of setup) {
		assert.equal(schema.safeParse(envelope(input)).success, true, name);
		for (const named of [
			{ ...envelope(input), plant },
			{ ...envelope(input), selected: plant },
			{ ...envelope(input), plantId: plant.id },
			envelope({ ...input, plant }),
			envelope({ ...input, plantId: plant.id }),
			envelope({ ...input, owner: plant }),
		])
			assert.equal(schema.safeParse(named).success, false, `${name} ${JSON.stringify(Object.keys(named))}`);
	}
});
