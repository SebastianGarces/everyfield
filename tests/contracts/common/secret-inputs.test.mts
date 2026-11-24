import assert from "node:assert/strict";
import { test } from "node:test";
import * as identity from "../../../packages/contracts/src/identity/requests.ts";
import * as native from "../../../packages/contracts/src/settings/native.ts";

type Schema = { _zod: { def: Record<string, unknown> & { type: string } }; safeParse(value: unknown): Parsed };
type Parsed = { success: true; data: unknown } | { success: false };
type Field = { name: string; schema: Schema };

const SECRET = /password|proof/i;
const VALUE = "  Correct Horse BATTERY staple  ";

const isSchema = (value: unknown): value is Schema =>
	typeof value === "object" && value !== null && "_zod" in value && "safeParse" in value;

function secretFields(name: string, schema: Schema, seen = new Set<Schema>()): Field[] {
	if (seen.has(schema)) return [];
	seen.add(schema);
	const def = schema._zod.def;
	const inner = (key: string) => (isSchema(def[key]) ? secretFields(name, def[key], seen) : []);
	switch (def.type) {
		case "object":
			return Object.entries(def.shape as Record<string, Schema>).flatMap(([key, field]) =>
				SECRET.test(key) ? [{ name: `${name}.${key}`, schema: field }] : secretFields(`${name}.${key}`, field, seen),
			);
		case "union":
			return (def.options as Schema[]).flatMap((option) => secretFields(name, option, seen));
		case "intersection":
			return [...inner("left"), ...inner("right")];
		case "pipe":
			return [...inner("in"), ...inner("out")];
		default:
			return inner("innerType");
	}
}

const exported: [string, unknown][] = [...Object.entries(identity), ...Object.entries(native)];
const fields = exported
	.filter((entry): entry is [string, Schema] => isSchema(entry[1]))
	.flatMap(([name, schema]) => secretFields(name, schema))
	.filter((field, i, all) => all.findIndex((other) => other.name === field.name) === i);

test("the identity and settings request schemas carry a password or proof field in every credential request", () => {
	const owners = new Set(fields.map((field) => field.name.split(".")[0]));
	for (const request of [
		"registrationRequest",
		"signInRequest",
		"recoverPasswordRequest",
		"changePasswordRequest",
		"openAccountDeletionRequest",
		"confirmEmailChange",
	])
		assert.ok(owners.has(request), `${request} has a password or proof field`);
	assert.ok(fields.some((field) => field.name === "registrationRequest.invitationProof"));
});

test("every password and proof field keeps its value byte for byte: no trimming, no case change", () => {
	for (const field of fields) {
		const parsed = field.schema.safeParse(VALUE);
		assert.ok(parsed.success, `${field.name} accepts a long mixed-case value with outer spaces`);
		assert.equal(parsed.data, VALUE, `${field.name} returns the value unchanged`);
	}
});
