// The real-model opt-in of the assessment evaluation (D92). Without ASSESSMENT_EVAL_REAL_MODEL=1 the evaluation stays
// scripted and makes no paid call. With it, the run needs EVRY_MODEL=gpt-6-luna and OPENAI_API_KEY, and is refused on
// a production deployment, while EVRY_SCRIPTED_MODEL=1 is set, and on any database but the shared development one
// (CI's disposable localhost database included), because its spend is charged to that database's model_spend counter.
import { assertDevelopmentDatabase, developmentHosts } from "../../../packages/db/src/development.ts";
import { paidModel } from "../../../packages/evry/src/runtime/model.ts";

export const REAL_MODEL_OPT_IN = "ASSESSMENT_EVAL_REAL_MODEL";

/** null for a scripted evaluation; for a real one, the shared development database URL its spend is metered on. */
export function realModelOptIn(env: Record<string, string | undefined>): { meterUrl: URL } | null {
	if (env[REAL_MODEL_OPT_IN] !== "1") return null;
	const refuse = (why: string) => Error(`${REAL_MODEL_OPT_IN}=1 refused: ${why}`);
	if (env.VERCEL_ENV === "production") throw refuse("never on production");
	if (env.EVRY_SCRIPTED_MODEL === "1") throw refuse("EVRY_SCRIPTED_MODEL=1 keeps the scripted model");
	let url: URL;
	try {
		url = assertDevelopmentDatabase(env.DATABASE_URL_UNPOOLED ?? env.DATABASE_URL);
	} catch {
		throw refuse("the shared development database is required");
	}
	if (!developmentHosts.has(url.hostname)) throw refuse("the shared development database is required");
	if (!paidModel(env)) throw refuse("EVRY_MODEL=gpt-6-luna and OPENAI_API_KEY are required");
	url.searchParams.set("sslmode", "verify-full");
	return { meterUrl: url };
}
