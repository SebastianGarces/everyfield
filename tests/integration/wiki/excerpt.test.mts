// WP-034/api criteria 1 to 8: the Guide excerpt cut rules on the seeded corpus and on built text. No database.
import { test } from "node:test";
import { checks } from "./excerpt-checks.mjs";

const names: Record<string, string> = {
	1: "the /intelligence Guide keeps the heading, the intro and the whole phase table",
	2: "the /meetings Guide never ends inside a word",
	3: "every Guide route, and every heading of the seed, ends at a block, sentence or whole word",
	4: "a paragraph is cut at its last sentence end, else at a whole word with …, never inside a span",
	5: "a list keeps only the whole items that fit",
	6: "a table that starts inside the limit stays whole up to the ceiling, then keeps whole rows",
	7: "an MDX component stays whole when it fits, else the excerpt stops before it",
	8: "the same rules hold without a heading and for safe_nodes text",
};

for (const [criterion, check] of Object.entries(checks))
	test(`WP-034/api criterion ${criterion}: ${names[criterion]}`, () => check());
