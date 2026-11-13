import { sql } from "@everyfield/db/query";
import { z } from "zod";
import { attachmentsOf, attachmentState, stagedIn } from "../../../attachments/store.ts";
import { EvryRefusal } from "../../../context/errors.ts";
import type { ReviewedWrite } from "../../../proposals/types.ts";
import { ownerOrAdmin } from "./index.ts";

// The import review (WP-054 handoff to WP-064): importing a People spreadsheet attached and checked in this
// conversation. The card is built only from the conversation's own latest saved check of that exact file
// (people.previewImport's saved result), so it shows what the person read: the file, its rows and what happens to each.
// A file replaced by a newer one with the same name, or a check of other bytes, refuses as file_changed and needs a fresh
// check; an expired file needs attaching again. Nothing changes until the person approves. Running the import after the
// approval belongs to the People records task (T-319), which replaces `execute`.

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const importInput = z.strictObject({
	attachmentId: z.uuid().describe("The attachmentId of a file attached in this conversation"),
	fileDigest: sha256.describe("The fileDigest of that file's latest people.previewImport check"),
});
const checked = z.object({
	rows: z.array(z.object({ kind: z.string(), id: z.string(), label: z.string(), fields: z.record(z.string(), z.unknown()) })),
});

export const executeBulkImport: ReviewedWrite<z.infer<typeof importInput>> = {
	operation: "people.executeBulkImport",
	description:
		"Propose importing a People spreadsheet attached in this conversation, after its latest check: each valid row is created or skipped as the check suggested. Nothing changes until the user approves the exact review.",
	input: importInput,
	allowed: ownerOrAdmin,
	async review(actor, value, { db, conversationId }) {
		if (!conversationId) return null;
		const r = await db.execute(sql`SELECT ${attachmentsOf("c")} AS attachments,
				(SELECT e.body->'result' FROM conversation_event e WHERE e.conversation_id=c.id AND e.kind='tool_result'
					AND e.body->>'operation'='people.previewImport' AND e.body->'input'->>'attachmentId'=${value.attachmentId}::text
					ORDER BY e.sequence DESC LIMIT 1) AS checked
			FROM conversation c WHERE c.id=${conversationId}::uuid AND c.account_id=${actor.accountId}::uuid AND c.tenant_id=${actor.owner.id}::uuid`);
		const row = r.rows[0] as { attachments: unknown; checked: unknown } | undefined;
		const file = z
			.array(attachmentState)
			.parse(row?.attachments ?? [])
			.find((a) => a.id === value.attachmentId);
		if (!file) throw new EvryRefusal("attachment_elsewhere");
		if (file.status === "gone") throw new EvryRefusal("attachment_gone");
		const check = checked.safeParse(row?.checked);
		const summary = check.success ? check.data.rows.find((x) => x.kind === "file") : undefined;
		// A newer file with the same name, or a check of other bytes, is not the file this review would import.
		if (file.status === "replaced" || !summary || summary.fields.fileDigest !== value.fileDigest)
			throw new EvryRefusal("file_changed");
		const rows = check.data!.rows.filter((x) => x.kind === "import");
		const valid = rows.filter((x) => x.fields.status === "valid");
		const choices = valid.map((x) => ({ row: Number(x.id), choice: x.fields.suggested === "skip" ? "skip" : "create" }));
		const count = (choice: string) => choices.filter((c) => c.choice === choice).length;
		const changes = [
			{ field: "file", before: null, after: file.name },
			{ field: "rows", before: null, after: rows.length },
			{ field: "create", before: null, after: count("create") },
			{ field: "skip", before: null, after: count("skip") },
			{ field: "invalid", before: null, after: rows.length - valid.length },
		];
		const args = {
			attachmentId: value.attachmentId,
			fileDigest: value.fileDigest,
			reviewDigest: String(summary.fields.reviewDigest),
			choices,
		};
		// The file must still be this conversation's live staged upload when the review is saved.
		return sql`SELECT jsonb_build_object('target','null'::jsonb,'changes',${JSON.stringify(changes)}::jsonb) AS review,
				${JSON.stringify(args)}::jsonb AS args
			FROM conversation c JOIN file_object f ON f.id=${value.attachmentId}::uuid AND f.tenant_id=c.tenant_id AND ${stagedIn("f", "c")}
			WHERE c.id=${conversationId}::uuid AND f.state='pending' AND f.expires_at>clock_timestamp()`;
	},
	// The import command itself lands with the People records task (T-319); until then an approval imports nothing.
	async execute() {
		return { refused: "import_not_available" };
	},
};
