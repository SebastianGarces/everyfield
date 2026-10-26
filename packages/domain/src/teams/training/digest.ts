import { hash } from "../../operations/canonical.ts";

/** Saved-roster proof. Person order does not change the digest. A later revision does. */
export function rosterDigest(input: {
	programId: string;
	revision: string;
	people: { id: string; revision: string }[];
}) {
	const people = input.people
		.map((person) => [person.id, person.revision] as const)
		.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
	return hash({ people, programId: input.programId, revision: input.revision });
}
