import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "../../../packages/db/src/query.ts";
import { RequestActor } from "../../../packages/domain/src/access/session.ts";
import { createWikiProducer } from "../../../packages/domain/src/wiki/index.ts";
import type { SourceView } from "../../../packages/contracts/src/wiki/index.ts";
import { fixture, ok, type Actor } from "../../support/fixture.mts";
import { recorded, untouched } from "../../support/recorded.mts";

export const GLOBAL = "00000000-0000-0000-0000-000000000000";
const { cases } = JSON.parse(readFileSync(new URL("../../../docs/acceptance/knowledge.json", import.meta.url), "utf8"));
export function knowledgeCase(id: string) {
	const found = cases.find((row: { id: string }) => row.id === id);
	assert.ok(found, id);
	return found;
}
export const present = <T,>(value: T | null | undefined, what: string): T => {
	if (value === null || value === undefined) assert.fail("missing " + what);
	return value;
};
const hash = () => randomBytes(32).toString("hex");

type Piece = {
	id?: string;
	slug?: string;
	title?: string;
	body?: string;
	phase?: number;
	tenant?: string;
	related?: readonly string[];
	parent?: string | null;
	section?: string;
	number?: number;
	meaningful?: boolean;
	sequence?: number;
};
type StoredReading = {
	article_id: string;
	observed: string;
	completed: string | null;
	bookmarked: boolean;
	sequence: number;
	completed_version: number | null;
	completed_source: string | null;
	last_version: number | null;
	last_source: string | null;
	done: boolean;
	completed_at: string | null;
};
type Org = { id: string; editor: Actor };

export async function wikiWorld(prefix: string) {
	const f = await fixture({ prefix, max: 6, clock: new Date("2026-10-13T16:00:00Z") });
	const { admin } = f;
	const db = f.pools.runtime;
	const api = createWikiProducer();
	const release = randomUUID();
	const section = randomUUID();
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','section-1',${GLOBAL})`,
	);
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},'cases','memory://synthetic',${hash()},'validated',clock_timestamp(),clock_timestamp(),'memory://approval',${hash()},'v','profile',1,${GLOBAL},0)`);
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
		VALUES(gen_random_uuid(),${release},1,clock_timestamp(),'synthetic','cases',0)`);

	const rows = async <T extends Record<string, unknown> = { n: number }>(query: ReturnType<typeof sql>) =>
		(await admin.execute<T>(query)).rows;
	const one = async <T extends Record<string, unknown> = { n: number }>(query: ReturnType<typeof sql>) =>
		present((await rows<T>(query))[0], "row");
	const actor = async (who: Pick<Actor, "session">) => {
		const resolved = await RequestActor.resolve(db, who.session);
		assert.ok(resolved instanceof RequestActor);
		return resolved;
	};
	const cmd = <I,>(input: I, expectedRevision = "0") => ({
		requestKey: randomUUID(),
		expectedRevision,
		input,
	});
	const reading = <I,>(input: I) => ({ requestKey: randomUUID(), input });

	async function revise(articleId: string, piece: Piece) {
		const id = randomUUID();
		const tenant = piece.tenant ?? GLOBAL;
		const slug = piece.slug ?? articleId;
		const title = piece.title ?? "Preparing leaders";
		await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,parent_article_id,related_slugs)
			VALUES(${id},${articleId},${tenant},${tenant === GLOBAL ? release : null},${piece.number ?? 1},${title},${slug},${title},${piece.body ?? "Prepare a leadership conversation."},
			${tenant === GLOBAL ? "safe_mdx" : "safe_nodes"},${piece.phase ?? 1},1,${hash()},clock_timestamp(),${piece.meaningful ?? true},${piece.sequence ?? 1},${piece.section ?? section},${piece.parent ?? null},
			ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(piece.related ?? [])}::jsonb)))`);
		return id;
	}
	async function article(piece: Piece = {}) {
		const id = piece.id ?? randomUUID();
		const slug = piece.slug ?? id;
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${id},'article',${(piece.tenant ?? "") + slug},${piece.tenant ?? GLOBAL})`,
		);
		const revisionId = await revise(id, { ...piece, slug });
		return { id, slug, revisionId };
	}
	async function organization(kind: "sending_church" | "sending_network", name: string) {
		const o = await f.organization(kind, { name, timezone: "America/Chicago" });
		return { ...o, editor: await f.actor(o, "admin") };
	}
	async function affiliate(plantId: string, organizationId: string) {
		const id = randomUUID();
		await admin.execute(sql`INSERT INTO affiliation(id,plant_id,organization_id,accepted_at,share_people,share_meetings,share_tasks,share_ministry_teams,share_wiki,share_activity,shared_findings)
			VALUES(${id},${plantId},${organizationId},clock_timestamp()-interval '10 minutes',false,false,false,false,true,false,false)`);
		return {
			id,
			end: () => admin.execute(sql`UPDATE affiliation SET ended_at=clock_timestamp() WHERE id=${id}`),
		};
	}
	const [S1, S2, N1] = [
		await organization("sending_church", "S1"),
		await organization("sending_church", "S2"),
		await organization("sending_network", "N1"),
	];
	async function church(orgs: readonly { id: string }[] = []) {
		const P = await f.plant({ name: "P", timezone: "America/Chicago", phase: 1 });
		const ended = new Map<string, () => Promise<unknown>>();
		for (const o of orgs) ended.set(o.id, (await affiliate(P.id, o.id)).end);
		return {
			P,
			A: await f.actor(P, "admin"),
			leave: (o: { id: string }) => present(ended.get(o.id), "affiliation")(),
		};
	}
	async function publish(o: Org, articleId: string, body: string, expected = "0") {
		const value = ok(
			await api.publishOrganizationArticle(
				db,
				await actor(o.editor),
				cmd({ articleId, organizationId: o.id, body }, expected),
			),
		);
		assert.equal(value.errorCode, null);
		return value;
	}
	const view = async (who: Actor, articleId: string, source?: SourceView) =>
		ok(await api.getArticle(db, await actor(who), { articleId, ...(source ? { source } : {}) }));
	const progress = async (who: Actor, articleId: string, fraction: number | string) =>
		ok(await api.updateProgress(db, await actor(who), reading({ articleId, fraction: String(fraction) })));
	const open = async (who: Actor, articleId: string) =>
		ok(await api.recordView(db, await actor(who), reading({ articleId })));
	const stored = async (who: Actor, articleId: string) =>
		rows<StoredReading>(sql`SELECT r.article_id,r.observed_fraction::text AS observed,r.completed_fraction::text AS completed,r.bookmarked,
			r.last_read_meaningful_sequence::int AS sequence,c.revision_number AS completed_version,c.tenant_id AS completed_source,
			l.revision_number AS last_version,l.tenant_id AS last_source,r.completed_at IS NOT NULL AS done,r.completed_at::text AS completed_at
			FROM reading r LEFT JOIN article_revision c ON c.id=r.completed_revision_id LEFT JOIN article_revision l ON l.id=r.last_revision_id
			WHERE r.account_id=${who.id} AND r.article_id=${articleId}`);
	return {
		f,
		admin,
		db,
		api,
		S1,
		S2,
		N1,
		rows,
		one,
		actor,
		cmd,
		revise,
		article,
		church,
		publish,
		view,
		progress,
		open,
		stored,
		kept: async (who: Actor, articleId: string) => present((await stored(who, articleId))[0], "reading"),
		recorded: <T,>(body: () => Promise<T>) => recorded(admin, body),
		untouched: <T,>(body: () => Promise<T>) => untouched(admin, body),
		close: () => f.close(),
	};
}

export function pdfText(bytes: Buffer) {
	const file = bytes.toString("latin1");
	assert.match(file, /^%PDF-1\.\d\n/);
	assert.match(file, /%%EOF$/);
	const start = Number(/startxref\n(\d+)\n%%EOF$/.exec(file)?.[1]);
	const lines = file.slice(start).split("\n");
	assert.equal(lines[0], "xref");
	const total = Number(lines[1]!.split(" ")[1]);
	const object = (id: number) => {
		const at = Number(lines[2 + id]!.slice(0, 10));
		const head = `${id} 0 obj\n`;
		assert.equal(file.slice(at, at + head.length), head);
		return file.slice(at + head.length, file.indexOf("\nendobj", at));
	};
	const trailer = file.slice(file.indexOf("trailer", start));
	assert.equal(Number(/\/Size (\d+)/.exec(trailer)?.[1]), total);
	const ref = (text: string, key: string) => Number(new RegExp(`/${key} (\\d+) 0 R`).exec(text)?.[1]);
	const pages = object(ref(object(ref(trailer, "Root")), "Pages"));
	const kids = [...(/\/Kids \[([^\]]*)\]/.exec(pages)?.[1] ?? "").matchAll(/(\d+) 0 R/g)].map((m) => Number(m[1]));
	assert.equal(kids.length, Number(/\/Count (\d+)/.exec(pages)?.[1]));
	const shown = (text: string) => text.replace(/\\([()\\])/g, "$1");
	return {
		title: shown(/\/Title \((.*)\) \/Producer/.exec(object(ref(trailer, "Info")))?.[1] ?? ""),
		pages: kids.map((kid) => {
			const content = object(ref(object(kid), "Contents"));
			const [, length, stream] = /^<< \/Length (\d+) >>\nstream\n([\s\S]*)\nendstream$/.exec(content) ?? [];
			assert.equal(stream?.length, Number(length));
			return [...present(stream, "page stream").matchAll(/\((.*)\) Tj/g)].map((m) => shown(m[1]!));
		}),
	};
}
