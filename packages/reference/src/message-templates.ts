import { readFile } from "node:fs/promises";
import { z } from "zod";
import { sql } from "@everyfield/db/query";
import type { Database } from "@everyfield/db/client";
import "server-only";
import { hash, stableId } from "./hash.ts";

const GLOBAL = "00000000-0000-0000-0000-000000000000";

const approvedMessageTemplateSource = {
	path: "docs/reference/communication-system-templates.ts",
	sha256: "07aa5ec09e7499b77d856e079c1c7312cc04dd443146f702e5a143ae6de561ba",
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
type MessageTemplateCaller = z.infer<typeof caller>;

export interface MessageTemplateDependencies {
	readSource?: (path: string) => Promise<Uint8Array>;
}

const repository = new URL("../../../", import.meta.url);
const readRepositoryFile = (path: string) => readFile(new URL(path, repository));

function templateNames(source: string): string[] {
	return [...source.matchAll(/^ {4}name: "([^"]+)",$/gm)].map(([, name = ""]) => name);
}

const publisher = (c: MessageTemplateCaller) => sql`SELECT a.id FROM account a
	JOIN platform_grant g ON g.account_id = a.id AND g.capability = 'reference_publish' AND g.revoked_at IS NULL
		AND (g.expires_at IS NULL OR g.expires_at > clock_timestamp())
	JOIN auth_session s ON s.id = ${c.sessionId}::uuid AND s.user_id = ${c.userId}::uuid
		AND s.expires_at > clock_timestamp() AND a.auth_user_id = s.user_id
	WHERE a.id = ${c.actorId}::uuid AND a.registration_state = 'active'`;

export function messageTemplateInstaller(db: Database, deps: MessageTemplateDependencies = {}) {
	const readSource = deps.readSource ?? readRepositoryFile;
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
		const items = names.map((name) => ({ id: stableId(`mail_template:${name}`), key: name }));
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
