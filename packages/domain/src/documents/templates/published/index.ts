import commitmentCardV1 from "./commitment-card.v1.json" with { type: "json" };
import versions from "./versions.json" with { type: "json" };

export type PublishedVersion = { version: number; hash: string };

export const PUBLISHED: Readonly<Record<string, readonly PublishedVersion[]>> = versions;

export const SUPERSEDED: Readonly<Record<string, unknown>> = {
	"commitment-card.v1": commitmentCardV1,
};
