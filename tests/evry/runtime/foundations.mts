import { randomUUID } from "node:crypto";
import foundations from "../../../docs/reference/discovery-foundations.json" with { type: "json" };
import { sql } from "../../../packages/db/src/query.ts";
import type { Database } from "../../support/test-database.mts";
import { GLOBAL } from "../adapters/wiki/corpus.mts";

export async function seedFoundations(admin: Database): Promise<string[]> {
	const release = randomUUID();
	await admin.execute(sql`INSERT INTO reference_release(id,release_key,artifact_locator,manifest_hash,state,complete_at,validated_at,approval_locator,approval_hash,chunker_version,embedding_profile,embedding_dimensions,tenant_id,expected_passages)
		VALUES(${release},'foundations','memory://f',md5('f'),'validated',clock_timestamp(),clock_timestamp(),'memory://a',md5('f'),'v','profile',1,${GLOBAL},0)`);
	const section = randomUUID();
	await admin.execute(
		sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${section},'section','discovery/start',${GLOBAL})`,
	);
	for (const [n, a] of foundations.articles.entries()) {
		await admin.execute(
			sql`INSERT INTO reference_item(id,kind,canonical_key,tenant_id) VALUES(${a.id},'article',${a.slug},${GLOBAL})`,
		);
		await admin.execute(sql`INSERT INTO article_revision(id,article_id,tenant_id,release_id,revision_number,title,slug,excerpt,body,content_type,phase,position,content_hash,published_at,meaningful,meaningful_sequence,section_id,related_slugs)
			VALUES(${randomUUID()},${a.id},${GLOBAL},${release},1,${a.title},${a.slug},${a.title},${"Words of " + a.title},'safe_mdx',0,${n + 1},md5(${a.id}),clock_timestamp(),true,1,${section},ARRAY[]::text[])`);
	}
	await admin.execute(sql`INSERT INTO reference_activation(id,release_id,activation_number,activated_at,actor_tombstone,reason,expected_prior_number)
		SELECT gen_random_uuid(),${release},n+1,clock_timestamp(),'synthetic','foundations',n
		FROM (SELECT coalesce(max(activation_number),0) AS n FROM reference_activation) prior`);
	return foundations.articles.map((a) => a.id);
}
