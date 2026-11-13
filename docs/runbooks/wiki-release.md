# Global Wiki release runbook (T-28)

This runbook publishes the pinned global Wiki release on the production database. Planters then read the living seed
(`docs/reference/wiki/seed.json`, 124 articles) instead of the original 96-article starter, and the Guide on
Settings > Brand kit shows real help. The release is pinned as `wiki-seed-f38baeb7f295` in
[approved.ts](../../packages/reference/src/starter/manifest/approved.ts). The command is the reference package's
[Wiki install command](../../packages/reference/src/starter/verify/cli.ts). It is idempotent: once the pinned release
is active, a rerun changes nothing.

Only Sebastian approves this run and touches production, or names the operator who does. No seat, check or CI job runs
it. It is not part of a deploy.

## What changes for planters

- Every global article shows the living seed's text. 28 articles exist only in the living seed, among them
  "Building Your Church's Brand: Logo, Tagline and Style Guide".
- "Setting Up a 501(c)(3)" shows the corrected text: churches cannot use Form 1023-EZ.
- The Guide on `/settings/brand` shows the "Choose colors and type people can read" section. The other 12 Guide screens
  keep their excerpts, now from the living seed's text.
- A church or network copy of an article stays as it is and still wins over the global version.
- "Updated since you read it" keeps its rule: a planter who finished an article sees the label when the article's
  meaningful-change sequence is higher than the one they read. A new release writes every global article as a new
  meaningful revision with the next sequence. All 96 starter articles have different text in the living seed, so every
  global article a planter finished before the switch shows "Updated since you read it" on the Wiki home and the
  article, until they read it again. The 28 new articles have no reading record and show no label.
- The command does not build search vectors (embeddings). The release activates with deferred derivatives, as on the
  development database.

## Before you start

1. Run from an up-to-date checkout of `main` that contains the pin above, with dependencies installed
   (`corepack pnpm install --frozen-lockfile`).
2. Choose the operator account. It must be `active` and hold an unrevoked, unexpired `reference_publish` grant in
   `platform_grant`. The service refuses any other account (`access_denied`). To check it, run this read-only query on
   production with that account's id:

   ```sql
   SELECT a.id, a.registration_state, g.capability, g.revoked_at, g.expires_at
   FROM account a JOIN platform_grant g ON g.account_id = a.id AND g.capability = 'reference_publish'
   WHERE a.id = '<account-id>';
   ```

   One row with `registration_state = 'active'`, `revoked_at` null and `expires_at` null or in the future means the
   account can publish. Granting the capability is a separate, deliberate production write by Sebastian:
   `INSERT INTO platform_grant(account_id, capability) VALUES ('<account-id>', 'reference_publish');`.
3. Note the current activation, so you know the prior release for a rollback:

   ```sql
   SELECT a.activation_number, r.release_key, a.reason, a.activated_at
   FROM reference_activation a JOIN reference_release r ON r.id = a.release_id
   ORDER BY a.activation_number DESC LIMIT 1;
   ```

4. Put the production connection strings in your shell for this one command only: `DATABASE_URL_UNPOOLED` (read
   first) and `DATABASE_URL`. A variable already in the shell wins over the `apps/web/.env.local` file the script
   loads. Never paste them into a file in the repository, a log or a chat.

## Publish

From the repository root:

```sh
corepack pnpm --filter @everyfield/reference wiki:install --production --operator <account-id>
```

The command refuses before it writes when:

- `--production` is set but the connection string names the shared development database
  ("--production names the production database, but DATABASE_URL is the development one.");
- `--operator` is missing or is not an account id;
- `--schema` is given (it is for development seed schemas only);
- no account has that id ("No account has that id.").

It then reads the current activation. When `wiki-seed-f38baeb7f295` is not active, it adds a ten-minute session for
the operator, installs and activates the release in one transaction, and deletes that session again, also on failure.
The activation and its audit event carry the operator's account id.

### Expected output

The last line is one JSON object. On the first run, with `N` the activation number you noted:

```json
{"release":"wiki-seed-f38baeb7f295","activationNumber":"N+1","replayed":false,"insertedArticles":124,"activeRelease":"wiki-seed-f38baeb7f295","previousRelease":"<prior release key>","changed":true}
```

`insertedArticles` is 124 when this release is new on the database, and 0 when it already exists there from an earlier
activation. `previousRelease` is null when the database had no Wiki activation. Keep this line: `previousRelease` is
the release a rollback goes back to.

On the development database the run printed
`{"release":"wiki-seed-f38baeb7f295","activationNumber":"2","replayed":false,"insertedArticles":124,"activeRelease":"wiki-seed-f38baeb7f295","previousRelease":"R1","changed":true}`.

A failure prints `Wiki install failed: <code>`, sometimes with a detail after the code, and exits 1. The prior release keeps serving. The codes are:

| Code | Meaning | What to do |
|---|---|---|
| `access_denied` | The operator has no live `reference_publish` grant, or the account is not active. | Fix the grant (step 2), then rerun. |
| `incomplete_candidate` | The checkout's seed or manifest bytes differ from the pin, or the seed failed validation. | Use a clean `main` checkout. If it repeats, stop and ask engineering. |
| `immutable_conflict` | A release with this key exists with different content. | Stop and ask engineering. |
| `revision_conflict` | Another activation landed while this one ran. | Rerun; the command reads the new state. |

### Rerun: no change

Run the same command again. It must print, with the same number:

```json
{"activeRelease":"wiki-seed-f38baeb7f295","activationNumber":"N+1","changed":false}
```

It writes nothing and adds no activation. Then check in the app: `/wiki/administrative/technology/building-your-churchs-brand`
opens, and the Guide on Settings > Brand kit shows the color and type advice.

## Roll back to the prior generation

A rollback appends a new activation of the prior release. History, attribution and audit stay. It does not undo reader
state or church and network copies. `cli.ts` has no rollback mode, so save the script below outside the repository,
for example as `/tmp/wiki-rollback.ts`. It calls the same reference service with `kind: "rollback"`, under the same
operator and session rules as the install.

The script rebuilds the prior release from its pin and refuses unless the result matches the stored release byte for
byte. The pin below is the original starter, `wiki-starter-2026-10-03`. On the development database that release has
the key `R1`, and this pin rebuilds it exactly. If `previousRelease` came from another pin, take that pin's values from
the git history of `approved.ts` and replace `PRIOR_PIN`. If `previousRelease` was null, there is nothing to roll back
to.

```ts
// Reactivates a prior global Wiki release. Run from packages/reference:
//   node --conditions=react-server /tmp/wiki-rollback.ts --production --operator <account-id> --release <previousRelease>
// Development scratch schemas only: --schema ui_<hex> instead of --production.
import { randomBytes, randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const PRIOR_PIN = {
	version: "wiki-starter-2026-10-03",
	manifestPath: "docs/reference/bootstrap/manifest.json",
	payloadPath: "docs/reference/bootstrap/global-seed-payload.json",
	manifestSha256: "b60b368d7c0ae901c26e429bcda314502e7e836bf97ad57525d9c8816724e68b",
	payloadSha256: "7933b93d693b73b3d8768aa2f7e2ad91fa665b6ec23127cb8b4856466d936f59",
	articles: 96,
	sections: 21,
	systemTemplates: 7,
};
const DEVELOPMENT = "ep-autumn-dew-b8ltidky";
const here = pathToFileURL(`${process.cwd()}/`);
const load = (path: string) => import(new URL(path, here).href);
const { createDatabase, closeDatabase } = await load("../db/src/client.ts");
const { sql } = await load("../db/src/query.ts");
const { approvedWiki } = await load("src/starter/manifest/approved.ts");
const { referenceService } = await load("src/starter/verify/service.ts");

const { values } = parseArgs({
	options: {
		production: { type: "boolean" },
		operator: { type: "string" },
		release: { type: "string" },
		schema: { type: "string" },
	},
});
const target = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "about:blank");
const development = target.hostname.startsWith(DEVELOPMENT);
if (!values.operator || !/^[0-9a-f-]{36}$/i.test(values.operator)) throw Error("--operator <account-id> is required.");
if (!values.release) throw Error("--release <previousRelease> is required.");
if (values.production ? development || values.schema : !development || !/^ui_[a-f0-9]{16}$/.test(values.schema ?? ""))
	throw Error("Use --production on production, or --schema ui_<hex> on the development database.");
if (development) target.searchParams.set("sslmode", "verify-full");
const options = values.schema ? `-c search_path=${values.schema},pg_catalog,pg_temp` : undefined;
const db = createDatabase({ connectionString: target.href, max: 2, ...(options ? { options } : {}) });
const sessionId = randomUUID();
try {
	const operator = (await db.execute(sql`SELECT auth_user_id FROM account WHERE id = ${values.operator}::uuid`))
		.rows[0] as { auth_user_id: string } | undefined;
	if (!operator) throw Error("No account has that id.");
	const current = (
		await db.execute(sql`SELECT activation_number::text AS n FROM reference_activation
			ORDER BY activation_number DESC LIMIT 1`)
	).rows[0] as { n: string } | undefined;
	if (!current) throw Error("No Wiki activation to roll back from.");
	await db.execute(sql`INSERT INTO auth_session(id, user_id, token, expires_at)
		VALUES (${sessionId}::uuid, ${operator.auth_user_id}::uuid, ${randomBytes(32).toString("hex")}, now() + interval '10 minutes')`);
	const receipt = await referenceService(db, { source: PRIOR_PIN }).installApprovedWiki(
		{ actorId: values.operator, userId: operator.auth_user_id, sessionId },
		{
			release: values.release,
			manifestSha256: PRIOR_PIN.manifestSha256,
			payloadSha256: PRIOR_PIN.payloadSha256,
			requestKey: `wiki-rollback:${values.release}:${current.n}`,
			expectedActivation: current.n,
			target: approvedWiki.target,
			kind: "rollback",
		},
	);
	console.log(JSON.stringify(receipt));
} catch (error) {
	console.error(`Wiki rollback failed: ${error instanceof Error ? error.message.split("\n")[0] : "unknown error"}`);
	process.exitCode = 1;
} finally {
	await db.execute(sql`DELETE FROM auth_session WHERE id = ${sessionId}::uuid`);
	await closeDatabase(db);
}
```

Run it from `packages/reference`, with the same production connection strings in the shell:

```sh
cd packages/reference
node --conditions=react-server /tmp/wiki-rollback.ts --production --operator <account-id> --release <previousRelease>
```

It prints `{"release":"<previousRelease>","activationNumber":"N+2","replayed":false,"insertedArticles":0,"activeRelease":"<previousRelease>"}`.
Running it again while that release is active prints the same activation number and adds no activation. A failure
prints `Wiki rollback failed: <code>` and exits 1: `access_denied` without a live grant, `rollback_unavailable` when
that release was never active, and `immutable_conflict` when the pin does not rebuild the stored release.

While the prior release is active, `wiki:install` sees that the pinned release is not active and would activate it
again. Run it only when you mean to publish again: it prints `"insertedArticles":0`, because the release already
exists.
