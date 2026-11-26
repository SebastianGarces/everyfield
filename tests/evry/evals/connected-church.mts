import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import type { Database } from "../../../packages/db/src/client.ts";
import { ACTOR_SPECS, GRACE_AUSTIN, ORGANIZATION, PLANT } from "./golden-church.mts";

const id = (n: number) => `5b6d1f0e-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const INVITED = { grace: id(0x1c01), hill: id(0x1c02) } as const;
const LETTER_FILE = id(0x1c05);

export async function seedConnected(admin: Database) {
	const owner = ACTOR_SPECS.owner.account;
	for (const [invitation, organization, recipient] of [
		[INVITED.grace, GRACE_AUSTIN, "connect@graceaustin.example.test"],
		[INVITED.hill, ORGANIZATION, "org@example.test"],
	] as const) {
		await admin.execute(sql`INSERT INTO invitation(id,tenant_id,purpose,recipient_email,inviter_id,token_hash,state,created_at,revision)
			VALUES(${invitation},${PLANT},'plant_church',${recipient},${owner},${"f".repeat(32) + invitation.replaceAll("-", "")},'pending','2026-11-07T15:00:00Z',1)`);
		await admin.execute(sql`INSERT INTO relationship_invitation(invitation_id,plant_id,organization_id,inviter_description,subject_revision)
			VALUES(${invitation},${PLANT},${organization},'Hope Fellowship',1)`);
	}
	await admin.execute(sql`UPDATE affiliation SET accepted_at=date_trunc('minute',accepted_at) WHERE plant_id=${PLANT}`);
	const [photo, bytes] = [id(0x1c03), id(0x1c04)];
	const file = (key: string, owned: string, purpose: string, type: string, size: number) =>
		admin.execute(sql`INSERT INTO file_object(id,tenant_id,purpose,opaque_key,media_type,max_bytes,byte_count,sha256,state,upload_key,claim_generation)
			VALUES(${key},${owned},${purpose},${`private/${owned}/${key}`},${type},${size},${size},${"0".repeat(64)},'ready',${key},0)`);
	await file(photo, owner, "avatar", "image/png", 10);
	await admin.execute(sql`UPDATE account SET avatar_object_id=${photo} WHERE id=${owner}`);
	await file(bytes, PLANT, "generated", "application/pdf", 48_213);
	await admin.execute(sql`INSERT INTO generated_document(id,tenant_id,creator_account_id,template_id,template_version,saved_template_name,
			renderer_version,format,object_id,inputs,download_name,generated_at,request_key)
		VALUES(${LETTER_FILE},${PLANT},${owner},'follow-up-letter','1','Vision Meeting Follow-up Letter','1','pdf',${bytes},
			'[{"key":"church_name","value":"Hope Fellowship","source":"church_name"}]','vision-meeting-follow-up-letter.pdf','2026-11-03T16:00:00Z','golden-letter')`);
}
