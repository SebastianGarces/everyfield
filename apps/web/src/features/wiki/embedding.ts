import "server-only";
import type { Database } from "@everyfield/db/client";
import { EMBEDDING_PATH, providerAllowed } from "@everyfield/db/deployment";
import { runDueWikiEmbedding, wikiPassageEmbedder } from "@everyfield/domain/wiki";
import { serverEnv, type ServerEnv } from "../../server/config.ts";

export function wikiEmbeddingMount(db: Database, env: ServerEnv = serverEnv()) {
	if (!providerAllowed(env, EMBEDDING_PATH)) return null;
	const embedder = wikiPassageEmbedder(env);
	return (limit: number, until: number) => runDueWikiEmbedding(db, embedder, limit, until);
}
