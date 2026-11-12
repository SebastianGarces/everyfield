import commitmentCardV1 from "./commitment-card.v1.json" with { type: "json" };
import versions from "./versions.json" with { type: "json" };

// Every published version of each built-in template (D-421): its version number and hash in versions.json, oldest
// first, and the body of each version a later one superseded as `<id>.v<version>.json` in this folder, listed in
// SUPERSEDED. The current version's body is the template file itself, so a body is copied here only when a new
// version supersedes it. tests/integration/documents/published-templates.test.mts holds the store to the files.

export type PublishedVersion = { version: number; hash: string };

/** The published versions of each built-in template, by template id. */
export const PUBLISHED: Readonly<Record<string, readonly PublishedVersion[]>> = versions;

/** The body of each superseded version, by `<id>.v<version>`. A test keeps this list equal to the folder. */
export const SUPERSEDED: Readonly<Record<string, unknown>> = {
	"commitment-card.v1": commitmentCardV1,
};
