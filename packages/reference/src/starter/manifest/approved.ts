/** One reviewed Wiki source: the files a generation is built from, their hashes and counts. */
export interface WikiSource {
	version: string;
	manifestPath: string;
	payloadPath: string;
	manifestSha256: string;
	payloadSha256: string;
	articles: number;
	sections: number;
	systemTemplates: number;
}

// Pins for the approved global Wiki: the living seed that `bin/wiki promote` maintains.
// The bootstrap payload stays unchanged as its `derivedFrom` provenance and is never installed.
// Update after each promotion with `node packages/reference/src/starter/manifest/pin.mjs --write`.
const approvedSource = {
	version: "wiki-seed-f38baeb7f295",
	manifestPath: "docs/reference/wiki/manifest.json",
	payloadPath: "docs/reference/wiki/seed.json",
	manifestSha256: "b4e53ea5df2c13eb467bfa3a5c6735ae55fce1910e119012370d4202fee4b1f9",
	payloadSha256: "f38baeb7f295c6f812e8e50ed4063af21fff179def7f651b3732ca66fc4edf09",
	articles: 124,
	sections: 21,
	systemTemplates: 7,
} as const satisfies WikiSource;

export const approvedWiki = {
	...approvedSource,
	target: "fresh-isolated-v3",
	discoveryPath: "docs/reference/discovery-foundations.json",
	playbookPath: "docs/reference/playbook.md",
	playbookSha256: "d365dd4992156e674f8e67601239fbf97c173074a3ca7e0bc8010aa725205e7a",
	provenanceRevision: "2107df58885c883960422ce7e60719f0adbac0e4",
	discoveryArticles: 6,
	documentTemplatesSeparate: 11,
	embeddingProfile: "local-deterministic-v1",
	embeddingDimensions: 8,
	chunker: "fixed-codepoints-1200-v1",
	rollbackReason: "Reviewed rollback of the approved Wiki snapshot",
} as const;
