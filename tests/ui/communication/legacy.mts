// Dev preview only: adds one message sent before the HTML editor, so the history detail shows its plain-text line
// (criterion 4). The row has recipient mail rows and a plain-text body but no stored HTML, the shape of a message
// recorded outside the Messages screens. Nothing is delivered. Run after the People and Communication seeds.
//
//   node --env-file=<home apps/web/.env.local> --conditions=react-server --import tsx tests/ui/communication/legacy.mts
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { addressAad, mailAddressHash, sealText } from "../../../packages/domain/src/communication/delivery.ts";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixturePath } from "../setup.mjs";
import { openSeedEnvironment } from "../seed-env.mts";

const people = JSON.parse(readFileSync(fixturePath("people"), "utf8"));
const env = await openSeedEnvironment(people.origin);
const id = randomUUID();
await env.admin.execute(sql`INSERT INTO communication (id, plant_id, revision, state, subject, body_text, audience)
	VALUES (${id}::uuid, ${people.plant}::uuid, 1, 'reviewed', 'Thank you for coming',
	'Thank you for coming on Sunday.' || chr(10) || 'We hope to see you again.', '{"groups":[],"teamIds":[],"personIds":[]}'::jsonb)`);
for (const [name, address] of [["Sara Nunez", "sara@legacy.example.test"]] as const) {
	const personId = people.people[name] as string;
	const mailId = randomUUID();
	const sealed = sealText(env.mailKey, address, addressAad(people.plant, mailId));
	await env.admin.execute(sql`INSERT INTO mail (id, tenant_id, recipient_person_id, recipient_address_encrypted, purpose,
		logical_key, payload_hash, audience_hash, frozen_payload, state, address_hash, created_at, sent_at, accepted_at)
		VALUES (${mailId}::uuid, ${people.plant}::uuid, ${personId}::uuid, ${sealed}, 'communication',
		${`communication/${id}/${personId}`}, 'payload', 'audience', '{"v":1,"sealed":"x"}'::jsonb, 'sent',
		${mailAddressHash(env.addressKey, address)}, clock_timestamp(), clock_timestamp(), clock_timestamp())`);
}
await env.close();
console.log(JSON.stringify({ legacy: id }));
