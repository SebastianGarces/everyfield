import { sql, type SQL } from "@everyfield/db/query";

// The recipient search rule, shared with the people search (S2 Tasks 2 and 14). A query matches a person when each
// query word is the start of a word in the display name, or the start of a word in the email local part. Name words
// split on spaces, hyphens and apostrophes. Local-part words split on `.`, `_`, `-` and `+`. The domain never matches.
// Matching ignores case.

const escapeRegex = (word: string) => word.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");

/** The query words, lowercased, with empty parts removed. */
export const queryWords = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);

/** A boolean SQL fragment for `person` rows exposed as `display_name` and `email`. */
export function personMatches(query: string): SQL {
	const words = queryWords(query);
	if (words.length === 0) return sql`FALSE`;
	const parts = words.map((word) => {
		const safe = escapeRegex(word);
		const name = `(^|[[:space:]'\u2019-])${safe}`;
		const local = `(^|[._+-])${safe}`;
		return sql`(display_name ~* ${name} OR split_part(coalesce(email, ''), '@', 1) ~* ${local})`;
	});
	return sql.join(parts, sql` AND `);
}
