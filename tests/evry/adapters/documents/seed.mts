// Documents for the Documents adapter suites, written as the app stores them: a written document holds a native body,
// a Church Document holds a template forked with the church's details. Each church gets its own set, so a read in one
// church can be checked never to return the other's.
import { randomUUID } from "node:crypto";
import { forkTemplate, nativeFromText } from "../../../../packages/contracts/src/documents/index.ts";
import { docTemplateById } from "../../../../packages/domain/src/documents/doc-templates.ts";
import { admin, sql } from "../../runtime/support.mts";

export type Seeded = { id: string; title: string; text: string | null };

/** One document and its first revision, recorded `daysAgo` days before now. */
export async function seedDocument(
	tenant: string,
	kind: "native" | "core_values" | "church_document",
	title: string,
	text: string | null,
	daysAgo = 1,
): Promise<Seeded> {
	const id = randomUUID();
	const revision = randomUUID();
	const policy = docTemplateById("conflict-of-interest-policy")!;
	const church = kind === "church_document";
	const body = church
		? JSON.stringify({
				...(await forkTemplate(policy, { id: `doc-${id}`, data: { church_name: "Synthetic" } })),
				title,
			})
		: JSON.stringify(nativeFromText(text ?? ""));
	await admin.execute(sql`INSERT INTO document(id,tenant_id,kind,title,revision,template_id,template_version,document_class,use_church_branding,input_provenance)
		VALUES(${id},${tenant},${kind},${title},1,${church ? policy.id : null},${church ? policy.version : null},
			${church ? policy.class : null},${church ? true : null},${church ? "[]" : null}::jsonb)`);
	await admin.execute(sql`INSERT INTO document_revision(id,tenant_id,document_id,version_number,body,content_hash,published_at,recorded_at)
		VALUES(${revision},${tenant},${id},1,${body},${"0".repeat(64)},clock_timestamp()-make_interval(days=>${daysAgo}),
			clock_timestamp()-make_interval(days=>${daysAgo}))`);
	await admin.execute(sql`UPDATE document SET current_revision_id=${revision} WHERE id=${id}`);
	return { id, title, text };
}
