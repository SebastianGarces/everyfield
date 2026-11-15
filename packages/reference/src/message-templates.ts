import { readFile } from "node:fs/promises";
import { z } from "zod";
import { sql } from "@everyfield/db/query";
import type { Database } from "@everyfield/db/client";
import "server-only";
import { hash, stableId } from "./hash.ts";

// reference.installMessageTemplates (REF-006): registers the seven global system message templates as global reference
// items, one per entry of the approved reference source. The source is the preserved original catalog, pinned by its
// SHA-256; its bytes never change. The approved copy a church reads and forks lives in
// @everyfield/contracts/communication, so an install never writes a subject or body and never touches a church's
// fork. The identities match the Wiki starter install (`mail_template:<name>`), so both producers name the same seven.

const GLOBAL = "00000000-0000-0000-0000-000000000000";

/** The one approved source: the original system template catalog, preserved byte for byte. */
export const approvedMessageTemplateSource = {
	path: "docs/reference/communication-system-templates.ts",
	sha256: "07aa5ec09e7499b77d856e079c1c7312cc04dd443146f702e5a143ae6de561ba",
	templates: 7,
} as const;

type Code = "access_denied" | "source_unavailable" | "digest_conflict";
export class MessageTemplateRefusal extends Error {
	readonly code: Code;
	constructor(code: Code) {
		super(code);
		this.code = code;
	}
}

const caller = z.strictObject({ actorId: z.uuid(), userId: z.uuid(), sessionId: z.uuid() });
const command = z.strictObject({
	source: z.strictObject({ path: z.literal(approvedMessageTemplateSource.path), sha256: z.string() }),
});
export type MessageTemplateCaller = z.infer<typeof caller>;

export interface MessageTemplateDependencies {
	/** The source's bytes by repository path; throws when the source is unavailable. */
	readSource?: (path: string) => Promise<Uint8Array>;
}

const repository = new URL("../../../", import.meta.url);
const readRepositoryFile = (path: string) => readFile(new URL(path, repository));

/** Each catalog entry's name, in order: the entries of `SYSTEM_TEMPLATES` open with `name: "<identity>",`. */
function templateNames(source: string): string[] {
	return [...source.matchAll(/^ {4}name: "([^"]+)",$/gm)].map((m) => m[1]!);
}

/** An active reference publisher with a live session: the same gate the Wiki install reads. */
const publisher = (c: MessageTemplateCaller) => sql`SELECT a.id FROM account a
	JOIN platform_grant g ON g.account_id = a.id AND g.capability = 'reference_publish' AND g.revoked_at IS NULL
		AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
	JOIN auth_session s ON s.id = ${c.sessionId}::uuid AND s.user_id = ${c.userId}::uuid
		AND s.expires_at > clock_timestamp() AND a.auth_user_id = s.user_id
	WHERE a.id = ${c.actorId}::uuid AND a.registration_state = 'active'`;

export function messageTemplateInstaller(db: Database, deps: MessageTemplateDependencies = {}) {
	const readSource = deps.readSource ?? readRepositoryFile;
	/**
	 * Installs the seven system templates from the approved source. A second install of the same source writes nothing.
	 * Refused before any source read for a caller who is not a reference publisher; an unavailable or changed source
	 * writes nothing and leaves what an earlier install committed.
	 */
	async function installMessageTemplates(callerInput: unknown, input: unknown) {
		const who = caller.safeParse(callerInput);
		const parsed = command.safeParse(input);
		if (!who.success || !parsed.success) throw new MessageTemplateRefusal("access_denied");
		const gate = await db.execute(sql`SELECT EXISTS (${publisher(who.data)}) AS allowed`);
		if ((gate.rows[0] as { allowed: boolean }).allowed !== true) throw new MessageTemplateRefusal("access_denied");
		const bytes = await readSource(parsed.data.source.path).catch(() => {
			throw new MessageTemplateRefusal("source_unavailable");
		});
		const digest = hash(bytes);
		if (digest !== parsed.data.source.sha256 || digest !== approvedMessageTemplateSource.sha256)
			throw new MessageTemplateRefusal("digest_conflict");
		const names = templateNames(Buffer.from(bytes).toString("utf8"));
		if (names.length !== approvedMessageTemplateSource.templates || new Set(names).size !== names.length)
			throw new MessageTemplateRefusal("digest_conflict");
		const items = names.map((name) => ({ id: stableId(`mail_template:${name}`), key: name }));
		// One statement: the publisher gate again, the missing items, and how many of the seven are now installed.
		const written = await db.execute(sql`WITH gate AS (${publisher(who.data)} FOR SHARE OF a),
			ins AS (
				INSERT INTO reference_item (id, kind, canonical_key, tenant_id)
				SELECT x.id, 'mail_template', x.key, ${GLOBAL}::uuid
				FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS x(id uuid, key text)
				WHERE EXISTS (SELECT 1 FROM gate)
				ON CONFLICT (kind, canonical_key) DO NOTHING
				RETURNING id
			)
			SELECT EXISTS (SELECT 1 FROM gate) AS allowed, (SELECT count(*)::int FROM ins) AS installed,
				(SELECT count(*)::int FROM reference_item WHERE kind = 'mail_template' AND tenant_id = ${GLOBAL}::uuid
					AND canonical_key = ANY(${sql.param(names)}::text[])) AS present`);
		const row = z
			.object({ allowed: z.boolean(), installed: z.number().int(), present: z.number().int() })
			.parse(written.rows[0]);
		if (!row.allowed) throw new MessageTemplateRefusal("access_denied");
		return { sourceSha256: digest, installed: row.installed, systemTemplateCount: row.present + row.installed };
	}
	return { installMessageTemplates };
}
