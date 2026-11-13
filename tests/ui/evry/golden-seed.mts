// Seeds Hope Fellowship, the golden-set church the Evry evals read (tests/evry/evals/golden-church.mts), into a local
// preview's tests/ui seed environment, so a person can ask the Done questions of T-318 in the Evry panel. Every task date
// and the Johnsons' call move with the preview's today (the evals' Mon 9 Nov 2026 becomes today in America/Chicago).
// The preview runs the scripted model (EVRY_SCRIPTED_MODEL=1), which this seed adds to the preview's env file.
//
//   up:     node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/evry/golden-seed.mts up <preview-url>
//   state:  … golden-seed.mts johnsons contacted|attempted|admin|none   (criterion 3: the recorded call's outcome)
//           … golden-seed.mts daniel ana|none                          (criterion 4: Daniel's follow-up owner)
//   down:   … golden-seed.mts down
//
// `up` writes a session cookie for the Owner (Nate Ellis), the Admin (Lena Park), the Member (Priya Shah) and the
// sending-church seat to $GOLDEN_UI_FIXTURE (default /tmp/everyfield-golden-ui.json).
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createHmac } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JOHNSON_CALL, NOW, PLANT, SEATS, seedGolden, taskId } from "../../evry/evals/golden-church.mts";
import { fixturePath } from "../setup.mjs";
import { dropSeed, openSeedEnvironment, writeFixture } from "../seed-env.mts";

const ENV_FILE = fileURLToPath(new URL("../../../apps/web/.env.local", import.meta.url));

/** Whole days from the evals' today (NOW, in America/Chicago) to the preview's today. */
function shiftDays() {
	const local = (at: Date) => at.toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
	return Math.round((Date.parse(local(new Date())) - Date.parse(local(NOW))) / 86_400_000);
}
/** A Better Auth session cookie for a seeded session token, signed with the preview's identity secret. */
function cookie(origin: string, token: string, secret: string) {
	const signature = createHmac("sha256", secret).update(token).digest("base64");
	const name = origin.startsWith("https:") ? "__Secure-better-auth.session_token" : "better-auth.session_token";
	return `${name}=${encodeURIComponent(`${token}.${signature}`)}`;
}

async function up(origin: string) {
	const env = await openSeedEnvironment(origin);
	try {
		const days = shiftDays();
		await seedGolden(env.admin, { shiftDays: days, preview: true });
		await env.admin.execute(
			sql`UPDATE auth_session SET expires_at=clock_timestamp()+interval '14 days' WHERE token LIKE 'golden-%'`,
		);
		// The preview answers with the scripted model; its env file is this seed environment's own.
		if (!/^EVRY_SCRIPTED_MODEL=1$/m.test(readFileSync(ENV_FILE, "utf8")))
			appendFileSync(ENV_FILE, "EVRY_SCRIPTED_MODEL=1\n");
		const cookies = Object.fromEntries(
			(["owner", "admin", "member", "org"] as const).map((who) => [who, cookie(origin, `golden-${who}`, env.secret)]),
		);
		const fixture = writeFixture("golden", env.schema, { origin, plant: PLANT, shiftDays: days, cookies });
		console.log(JSON.stringify({ schema: env.schema, fresh: env.fresh, shiftDays: days, fixture }));
	} finally {
		await env.close();
	}
}

/** Puts one fixture fact in the state a criterion asks about, in the preview the fixture was seeded into. */
async function state(fact: string, value: string) {
	const { origin } = JSON.parse(readFileSync(fixturePath("golden"), "utf8")) as { origin: string };
	const env = await openSeedEnvironment(origin);
	const run = (q: ReturnType<typeof sql>) => env.admin.execute(q);
	try {
		if (fact === "johnsons") {
			const outcome = { contacted: "contacted", attempted: "attempted_no_contact", admin: "administrative_completion" }[
				value
			];
			if (value === "none") {
				await run(sql`DELETE FROM audit_event WHERE subject_id=${JOHNSON_CALL.id}`);
				await run(sql`DELETE FROM contact_outcome WHERE id=${JOHNSON_CALL.id}`);
				await run(sql`UPDATE task SET status='not_started',completed_at=NULL WHERE id=${taskId("beth")}`);
			} else if (outcome) {
				const r = await run(sql`UPDATE contact_outcome SET outcome=${outcome},
					contact_channel=${outcome === "administrative_completion" ? null : "phone"} WHERE id=${JOHNSON_CALL.id}`);
				if (!r.rowCount) throw Error("The Johnsons' call was removed: run up again on a fresh seed to restore it.");
			} else throw Error("johnsons contacted|attempted|admin|none");
		} else if (fact === "daniel") {
			await run(sql`DELETE FROM task_assignee WHERE task_id=${taskId("daniel")}`);
			if (value === "ana")
				await run(
					sql`INSERT INTO task_assignee(plant_id,task_id,account_id) VALUES(${PLANT},${taskId("daniel")},${SEATS.ana.account})`,
				);
			else if (value !== "none") throw Error("daniel ana|none");
			await run(sql`UPDATE task SET revision=revision+1 WHERE id=${taskId("daniel")}`);
		} else throw Error("Usage: golden-seed.mts johnsons … | daniel …");
		console.log(JSON.stringify({ [fact]: value }));
	} finally {
		await env.close();
	}
}

const [action, ...args] = process.argv.slice(2);
if (action === "up") await up(args[0] ?? "");
else if (action === "down") console.log(JSON.stringify(await dropSeed("golden")));
else if (action === "johnsons" || action === "daniel") await state(action, args[0] ?? "");
else throw Error("Usage: golden-seed.mts up <preview-url> | johnsons <state> | daniel <state> | down");
