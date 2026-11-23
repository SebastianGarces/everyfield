import type { Database } from "@everyfield/db/client";
import { alias, and, eq, inArray } from "@everyfield/db/query";
import { article_editor_state, article_revision, organization, reading } from "@everyfield/db/tables";
import "server-only";
import type { RequestActor } from "../access/session.ts";

const NO_ORGANIZATION = "00000000-0000-0000-0000-000000000000";
const COMPLETED_FRACTION = 0.8;

export type StoredEditor = {
	revision: string;
	state: "published" | "hide" | "draft" | "inherited" | null;
	draftBody: string | null;
	draftType: "safe_mdx" | "safe_nodes" | null;
	currentBody: string | null;
	currentType: "safe_mdx" | "safe_nodes" | null;
};

const unedited: StoredEditor = {
	revision: "0",
	state: null,
	draftBody: null,
	draftType: null,
	currentBody: null,
	currentType: null,
};

export async function readEditorState(db: Database, organizationId: string, articleId: string): Promise<StoredEditor> {
	const draft = alias(article_revision, "wiki_draft_revision");
	const current = alias(article_revision, "wiki_current_revision");
	const rows = await db
		.select({
			revision: article_editor_state.revision,
			state: article_editor_state.state,
			draftBody: draft.body,
			draftType: draft.content_type,
			currentBody: current.body,
			currentType: current.content_type,
		})
		.from(article_editor_state)
		.leftJoin(draft, eq(draft.id, article_editor_state.draft_revision_id))
		.leftJoin(current, eq(current.id, article_editor_state.current_revision_id))
		.where(
			and(eq(article_editor_state.organization_id, organizationId), eq(article_editor_state.article_id, articleId)),
		)
		.limit(1);
	return rows[0] ?? unedited;
}

export async function getReadingRevision(db: Database, actor: RequestActor, articleId: string): Promise<string> {
	const rows = await db
		.select({ revision: reading.revision })
		.from(reading)
		.where(and(eq(reading.account_id, actor.actor.accountId), eq(reading.article_id, articleId)))
		.limit(1);
	return rows[0]?.revision ?? "0";
}

export async function listCompletedArticles(
	db: Database,
	actor: RequestActor,
	articleIds: string[],
): Promise<Set<string>> {
	if (articleIds.length === 0) return new Set();
	const rows = await db
		.select({ articleId: reading.article_id, fraction: reading.observed_fraction, completedAt: reading.completed_at })
		.from(reading)
		.where(and(eq(reading.account_id, actor.actor.accountId), inArray(reading.article_id, articleIds)));
	return new Set(
		rows
			.filter((row) => row.completedAt != null && Number(row.fraction) > COMPLETED_FRACTION)
			.map((row) => row.articleId),
	);
}

export async function listOrganizationNames(db: Database, ids: string[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids)].filter((id) => id !== NO_ORGANIZATION);
	if (unique.length === 0) return new Map();
	const rows = await db
		.select({ id: organization.id, name: organization.name })
		.from(organization)
		.where(inArray(organization.id, unique));
	return new Map(rows.map((row) => [row.id, row.name]));
}
