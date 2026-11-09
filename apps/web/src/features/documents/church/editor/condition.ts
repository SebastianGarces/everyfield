import type { ConditionTest, FieldDecl, IfNode } from "@everyfield/contracts/documents";

// Conditional text in the editor: the words of a condition and the tests each field type offers. Whether a block prints
// now is `conditionHolds`, the same function the PDF and the Word file print by.

export type Condition = IfNode["attrs"];

export const TEST_LABEL: Record<ConditionTest, string> = {
	"has-value": "Has a value",
	"is-empty": "Is empty",
	"more-than": "Is more than",
};

/** The tests a field offers: a text or date field has a value or is empty; a number or a list can also be more than. */
export function testsFor(field: Pick<FieldDecl, "type"> | undefined): ConditionTest[] {
	if (!field) return [];
	return field.type === "number" || field.type === "list"
		? ["has-value", "is-empty", "more-than"]
		: ["has-value", "is-empty"];
}

/** "Prints only when Attendees not shown is more than 0". */
export function conditionLabel(fields: readonly FieldDecl[], condition: Condition): string {
	const field = fields.find((f) => f.key === condition.field);
	const name = field?.label ?? condition.field;
	const value = condition.test === "more-than" ? ` ${condition.value ?? 0}` : "";
	return `Prints only when ${name} ${TEST_LABEL[condition.test]?.toLowerCase() ?? condition.test}${value}`;
}

/** A new condition on `field`: has a value. */
export const firstCondition = (fields: readonly FieldDecl[]): Condition | null =>
	fields[0] ? { field: fields[0].key, test: "has-value" } : null;

/**
 * The condition after one part changes. A test the field's type does not offer falls back to "has a value", and only
 * "is more than" keeps a value (0 when it had none).
 */
export function nextCondition(fields: readonly FieldDecl[], current: Condition, patch: Partial<Condition>): Condition {
	const merged = { ...current, ...patch };
	const tests = testsFor(fields.find((f) => f.key === merged.field));
	const test = tests.includes(merged.test) ? merged.test : "has-value";
	return test === "more-than" ? { field: merged.field, test, value: merged.value ?? 0 } : { field: merged.field, test };
}

/** The number a value box holds, or the reason it is not one: a whole number from 0. */
export function parseConditionValue(text: string): { value: number } | { problem: string } {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)))
		return { problem: `${trimmed || "(empty)"} is not a whole number from 0` };
	return { value: Number(trimmed) };
}

/** Why conditional text cannot be added to this document, or null when it can. */
export const noConditionReason = (fields: readonly FieldDecl[]) =>
	fields.length === 0 ? "This document has no fields for a condition to read." : null;
