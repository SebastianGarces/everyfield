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
export const approvedSource = {
	version: "wiki-seed-271f03b27196",
	manifestPath: "docs/reference/wiki/manifest.json",
	payloadPath: "docs/reference/wiki/seed.json",
	manifestSha256: "8cbab63c8828c5001ea5e1959855d913004a31397903865ab51acc545bbb5d18",
	payloadSha256: "271f03b271969b5357bbeeac09dcac61d3f9ef5a5ee9fc74b4a189d5a245f4bd",
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
