import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { PgDialect } from "../../../packages/db/node_modules/drizzle-orm/pg-core/index.js";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { newRsvpToken, rsvpLink } from "../../../packages/domain/src/meetings/tokens.ts";

test("a minted RSVP token yields no token text when bound as a SQL parameter or turned into text", () => {
	const token = newRsvpToken();
	const raw = rsvpLink("https://everyfield.test", token).split("/rsvp/")[1]!;
	assert.match(raw, /^[A-Za-z0-9_-]{43}$/);
	const query = new PgDialect().sqlToQuery(sql`SELECT ${token} AS value`);
	const shown = [
		query.sql,
		JSON.stringify(query.params),
		JSON.stringify({ token }),
		String(token),
		`${token}`,
		inspect(token, { showHidden: true, depth: null }),
		inspect(query.params, { showHidden: true, depth: null }),
	];
	for (const text of shown) assert.ok(!text.includes(raw), `token text leaked in: ${text}`);
});
