import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
	answerLeadRequest,
	completeOnboardingRequest,
	createPlantRequest,
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

test("AC:WP009-MUL-006 ordinary plant creation takes only the account's confirmed name and place, and refuses an organization actor, a seat transfer, commissioning, a geographic attestation and a chosen phase", () => {
	const command = {
		requestKey: "confirmed-creation",
		expectedRevision: "0",
		input: {
			name: "  Harvest Point  ",
			locality: { city: "  Boston  ", stateProvince: null, country: null },
			confirmed: true,
		},
	};
	const normalized = {
		requestKey: "confirmed-creation",
		expectedRevision: "0",
		input: {
			name: "Harvest Point",
			locality: { city: "Boston", stateProvince: null, country: null },
			confirmed: true,
		},
	};
	assert.deepEqual(createPlantRequest.parse(command), normalized);
	assert.deepEqual(createPlantRequest.parse(JSON.parse(JSON.stringify(normalized))), normalized);
	const organization = { kind: "organization", id: randomUUID(), organizationKind: "sending_church" };
	const seat = randomUUID();
	for (const extra of [
		{ organization },
		{ organizationId: organization.id },
		{ owner: organization },
		{ actor: organization },
		{ onBehalfOf: seat },
		{ seatTransfer: true },
		{ seatId: seat },
		{ transferSeatId: seat },
		{ commissioning: true },
		{ commissioned: true },
		{ residencyLinkId: seat },
		{ geographicAttestation: true },
		{ geography: { attested: true } },
		{ phase: 0 },
		{ phase: 1 },
		{ currentPhase: 4 },
	]) {
		const name = JSON.stringify(Object.keys(extra));
		assert.equal(createPlantRequest.safeParse({ ...command, ...extra }).success, false, `envelope ${name}`);
		assert.equal(
			createPlantRequest.safeParse({ ...command, input: { ...command.input, ...extra } }).success,
			false,
			`input ${name}`,
		);
	}
	for (const confirmed of [false, undefined])
		assert.equal(createPlantRequest.safeParse({ ...command, input: { ...command.input, confirmed } }).success, false);
});
