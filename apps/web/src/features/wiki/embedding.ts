import "server-only";
import type { Database } from "@everyfield/db/client";
import { runDueWikiEmbedding, wikiPassageEmbedder } from "@everyfield/domain/wiki";
import { serverEnv, type ServerEnv } from "../../server/config.ts";

export function wikiEmbeddingMount(db: Database, env: ServerEnv = serverEnv()) {
	const embedder = wikiPassageEmbedder(env);
	return (limit: number, until: number) => runDueWikiEmbedding(db, embedder, limit, until);
}
