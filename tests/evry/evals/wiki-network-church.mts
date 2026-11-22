import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { ACTOR_SPECS, WIKI } from "./golden-church.mts";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
type Spec = { account: string; user: string; session: string; name: string; role: "owner" | "admin" | "member" };
const spec = (k: number, name: string, role: Spec["role"]): Spec => ({
	account: id(0xb00 + k),
	user: id(0xb10 + k),
	session: id(0xb20 + k),
	name,
	role,
});
export const EDITOR_SPECS = {
	owner: spec(1, "Maya Brooks", "owner"),
	admin: spec(2, "Eli Turner", "admin"),
	member: spec(3, "Jo Kim", "member"),
} as const;
export type EditorName = keyof typeof EDITOR_SPECS | "church";
export const sessionOf = (who: EditorName) =>
	who === "church" ? ACTOR_SPECS.owner.session : EDITOR_SPECS[who].session;
export const NETWORK = WIKI.network;
export const VISION = WIKI.vision.article;
export const ROLES = WIKI.phaseTwo[1]!.article;

export async function seedWikiNetwork(admin: Database) {
	await admin.execute(sql`DELETE FROM article_editor_state WHERE organization_id=${NETWORK} AND article_id=${VISION}`);
	await admin.execute(sql`DELETE FROM article_revision WHERE tenant_id=${NETWORK} AND article_id=${VISION}`);
	for (const [who, a] of Object.entries(EDITOR_SPECS)) {
		await admin.execute(
			sql`INSERT INTO auth_user(id,email,email_verified,name) VALUES(${a.user},${`${who}@harvest.example.test`},true,${a.name})`,
		);
		await admin.execute(sql`INSERT INTO account(id,auth_user_id,registration_state,registration_kind)
			VALUES(${a.account},${a.user},'active','network')`);
		await admin.execute(sql`INSERT INTO auth_session(id,user_id,token,expires_at)
			VALUES(${a.session},${a.user},${`wiki-network-${who}`},clock_timestamp()+interval '1 day')`);
		await admin.execute(sql`INSERT INTO seat(account_id,organization_id,role,accepted_at)
			VALUES(${a.account},${NETWORK},${a.role},clock_timestamp()-interval '1 day')`);
	}
}
