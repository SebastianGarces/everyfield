import type { FlagDeclaration } from "@everyfield/domain/flags";
import { readFlag } from "./flags";

export async function anUnregisteredFlagIsATypeError() {
	// @ts-expect-error A flag that is not in the registry cannot be read.
	return readFlag("not-registered");
}

// @ts-expect-error A declaration without an expiry date does not typecheck.
export const aDeclarationNamesItsExpiry: FlagDeclaration = {
	owner: "Sebastian",
	task: "T-470",
	kind: "release",
	default: false,
	created: "2026-11-18",
};
