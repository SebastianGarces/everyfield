import type { ConditionTest, FieldDecl, IfNode } from "@everyfield/contracts/documents";

export type Condition = IfNode["attrs"];

export const TEST_LABEL: Record<ConditionTest, string> = {
	"has-value": "Has a value",
	"is-empty": "Is empty",
	"more-than": "Is more than",
};

export function testsFor(field: Pick<FieldDecl, "type"> | undefined): ConditionTest[] {
	if (!field) return [];
	return field.type === "number" || field.type === "list"
		? ["has-value", "is-empty", "more-than"]
		: ["has-value", "is-empty"];
}

export function conditionLabel(fields: readonly FieldDecl[], condition: Condition): string {
	const field = fields.find((f) => f.key === condition.field);
	const name = field?.label ?? condition.field;
	const value = condition.test === "more-than" ? ` ${condition.value ?? 0}` : "";
	return `Prints only when ${name} ${TEST_LABEL[condition.test]?.toLowerCase() ?? condition.test}${value}`;
}

export const firstCondition = (fields: readonly FieldDecl[]): Condition | null =>
	fields[0] ? { field: fields[0].key, test: "has-value" } : null;

export function nextCondition(fields: readonly FieldDecl[], current: Condition, patch: Partial<Condition>): Condition {
	const merged = { ...current, ...patch };
	const tests = testsFor(fields.find((f) => f.key === merged.field));
	const test = tests.includes(merged.test) ? merged.test : "has-value";
	return test === "more-than" ? { field: merged.field, test, value: merged.value ?? 0 } : { field: merged.field, test };
}

export function parseConditionValue(text: string): { value: number } | { problem: string } {
	const trimmed = text.trim();
	if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)))
		return { problem: `${trimmed || "(empty)"} is not a whole number from 0` };
	return { value: Number(trimmed) };
}

export const noConditionReason = (fields: readonly FieldDecl[]) =>
	fields.length === 0 ? "This document has no fields for a condition to read." : null;
