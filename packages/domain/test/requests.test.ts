import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import pg from "pg";
import { database, expireAccessRequests, exportAccessRequests } from "@everyfield/db";
import { receiveAccessRequest } from "../src/early-access/index.js";
import { GET } from "../../../apps/web/src/app/api/cron/access-retention/route.js";

if (process.env.EARLY_ACCESS_TEST_DATABASE !== "1") throw new Error("Use a disposable Neon branch and set EARLY_ACCESS_TEST_DATABASE=1");
const db = database();
const env = { RESEND_API_KEY: "fake-provider-key", EMAIL_FROM: "EveryField <hello@everyfield.app>", EARLY_ACCESS_EMAIL_TO: "owner@example.org" };
const planter = { name: " Sam Planter ", email: " SAM@EXAMPLE.ORG ", plant_name: "Hope Church", city: "Boston", phase: "0 · Discovery", sending: "Sending Church" };
const network = { name: "Alex", email: "alex@example.org", organization: "Network", role: "Director", plants: "12", message: "Please send details." };
let calls: { key: string; payload: unknown }[] = [];
let delivered = new Map<string, string>();
const fakeResend: typeof fetch = async (url, options) => {
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(options?.method, "POST");
  const headers = new Headers(options?.headers);
  assert.equal(headers.get("authorization"), "Bearer fake-provider-key");
  const key = headers.get("idempotency-key");
  assert.ok(key);
  assert.ok(key.startsWith("early-access/"));
  assert.equal(typeof options?.body, "string");
  calls.push({ key, payload: JSON.parse(String(options?.body)) });
  if (!delivered.has(key)) delivered.set(key, `mail-${delivered.size + 1}`);
  return Response.json({ id: delivered.get(key) });
};
const submit = (kind: unknown, fields: unknown, ip = "192.0.2.1", transport = fakeResend) => receiveAccessRequest(kind, fields, ip, { db, fetch: transport, env });
const count = async () => (await db.query<{ count: number }>("SELECT count(*)::int AS count FROM early_access_request")).rows[0]?.count;
beforeEach(async () => {
  await db.query("TRUNCATE early_access_request, early_access_attempt");
  calls = [];
  delivered = new Map();
});
after(async () => { await db.end(); });

test("INV-access: accepted forms normalize email, store every field and send one complete owner email each", async () => {
  assert.deepEqual(await submit("planter", planter), { status: "received" });
  assert.deepEqual(await submit("network", network), { status: "received" });
  const rows = (await db.query("SELECT kind, email, data, host(ip_address) AS ip, mail_id FROM early_access_request ORDER BY kind")).rows;
  assert.deepEqual(rows, [
    { kind: "network", email: "alex@example.org", data: { ...network, plants: 12 }, ip: "192.0.2.1", mail_id: "mail-2" },
    { kind: "planter", email: "sam@example.org", data: { ...planter, name: "Sam Planter", email: "sam@example.org" }, ip: "192.0.2.1", mail_id: "mail-1" },
  ]);
  assert.deepEqual(calls.map((c) => c.payload), [
    { from: env.EMAIL_FROM, to: [env.EARLY_ACCESS_EMAIL_TO], reply_to: "sam@example.org", subject: "EveryField early access: planter", text: "Form: planter\nName: Sam Planter\nEmail: sam@example.org\nPlant name: Hope Church\nCity: Boston\nPhase: 0 · Discovery\nSending church or network: Sending Church" },
    { from: env.EMAIL_FROM, to: [env.EARLY_ACCESS_EMAIL_TO], reply_to: "alex@example.org", subject: "EveryField early access: network", text: "Form: network\nName: Alex\nEmail: alex@example.org\nNetwork or church: Network\nRole: Director\nPlants sent or supported: 12\nMessage: Please send details." },
  ]);
  assert.equal(delivered.size, 2);
});

test("INV-access: invalid fields refuse storage and email", async () => {
  for (const [kind, fields, errors] of [
    ["planter", { ...planter, email: "wrong", city: "" }, { email: "email", city: "required" }],
    ["network", { ...network, plants: "-1" }, { plants: "number" }],
    ["unsupported", planter, {}],
    ["planter", null, {}],
  ]) {
    assert.deepEqual(await submit(kind, fields), { status: "invalid", fieldErrors: errors });
  }
  assert.equal(await count(), 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await submit("planter", planter), { status: "received" });
  assert.equal(await count(), 1);
});

test("INV-access: 24-hour duplicates use normalized email and form without another row or email", async () => {
  assert.deepEqual(await submit("planter", planter), { status: "received" });
  assert.deepEqual(await submit("planter", { ...planter, email: "sam@example.org", plant_name: "Changed" }), { status: "received" });
  assert.equal(await count(), 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(await submit("network", { ...network, email: "sam@example.org" }), { status: "received" });
  assert.equal(await count(), 2);
  await db.query("UPDATE early_access_request SET created_at = now() - interval '24 hours 1 second' WHERE kind = 'planter'");
  assert.deepEqual(await submit("planter", planter), { status: "received" });
  assert.equal(await count(), 3);
  assert.equal(delivered.size, 3);
});

test("INV-access: five valid attempts per normalized email in 24 hours then email refusal", async () => {
  for (let i = 0; i < 5; i++) assert.deepEqual(await submit("planter", planter, `192.0.2.${i + 1}`), { status: "received" });
  assert.deepEqual(await submit("network", { ...network, email: "sam@example.org" }), { status: "rate_limited", reason: "email" });
  assert.equal(await count(), 1);
  assert.equal(delivered.size, 1);
  await db.query("UPDATE early_access_attempt SET created_at = now() - interval '24 hours 1 second'");
  assert.deepEqual(await submit("network", { ...network, email: "sam@example.org" }), { status: "received" });
  assert.equal(await count(), 2);
});

test("INV-access: twenty attempts per IP in one hour then IP refusal", async () => {
  for (let i = 0; i < 20; i++) assert.deepEqual(await submit("network", { ...network, email: `person${i}@example.org` }), { status: "received" });
  assert.deepEqual(await submit("network", network), { status: "rate_limited", reason: "ip" });
  assert.equal(await count(), 20);
  assert.equal(delivered.size, 20);
  await db.query("UPDATE early_access_attempt SET created_at = now() - interval '1 hour 1 second'");
  assert.deepEqual(await submit("network", network), { status: "received" });
  assert.equal(await count(), 21);
});

test("INV-access: honeypot receives a fake receipt with no data, limit attempts or email", async () => {
  assert.deepEqual(await submit("planter", { website: "https://bot.example" }), { status: "received" });
  assert.deepEqual(await submit("network", { ...network, website: "bot" }), { status: "received" });
  assert.equal(await count(), 0);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM early_access_attempt")).rows[0].n, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(await submit("network", network), { status: "received" });
  assert.equal(delivered.size, 1);
});

test("INV-access: storage failure returns unavailable and sends nothing", async () => {
  const broken = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: "-c search_path=pg_catalog" });
  try {
    assert.deepEqual(await receiveAccessRequest("planter", planter, "192.0.2.1", { db: broken, fetch: fakeResend, env }), { status: "unavailable" });
    assert.equal(await count(), 0);
    assert.equal(calls.length, 0);
  } finally { await broken.end(); }
  assert.deepEqual(await submit("planter", planter), { status: "received" });
});

test("INV-access: mail rejection, missing receipt and timeout never claim success; retry keeps original row and payload", async () => {
  for (const transport of [
    async () => new Response("", { status: 500 }),
    async () => Response.json({}),
    async () => { throw new Error("Provider timeout"); },
  ]) assert.deepEqual(await submit("planter", planter, "192.0.2.1", transport), { status: "unavailable" });
  assert.equal(await count(), 1);
  assert.equal((await db.query("SELECT mailed_at FROM early_access_request")).rows[0].mailed_at, null);
  assert.deepEqual(await submit("planter", { ...planter, plant_name: "Changed on retry" }), { status: "received" });
  assert.equal(await count(), 1);
  assert.equal(delivered.size, 1);
  assert.match(JSON.stringify(calls[0]?.payload), /Hope Church/);
});

test("INV-access: failure to save mail receipt remains unavailable and retry cannot send another email", async () => {
  await db.query("ALTER TABLE early_access_request RENAME COLUMN mail_id TO withheld_mail_id");
  try {
    assert.deepEqual(await submit("planter", planter), { status: "unavailable" });
  } finally { await db.query("ALTER TABLE early_access_request RENAME COLUMN withheld_mail_id TO mail_id"); }
  assert.equal(delivered.size, 1);
  assert.deepEqual(await submit("planter", planter), { status: "received" });
  assert.equal(await count(), 1);
  assert.equal(delivered.size, 1);
  assert.equal(calls[0]?.key, calls[1]?.key);
  assert.deepEqual(calls[0]?.payload, calls[1]?.payload);
  await db.query("UPDATE early_access_request SET mailed_at = NULL, mail_id = NULL, created_at = now() - interval '24 hours'");
  assert.deepEqual(await submit("planter", planter), { status: "unavailable" });
  assert.equal(calls.length, 2);
});

test("INV-access: concurrent duplicates create one row and one provider email", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => submit("planter", planter)));
  assert.deepEqual(results, Array.from({ length: 5 }, () => ({ status: "received" })));
  assert.equal(await count(), 1);
  assert.equal(delivered.size, 1);
  assert.equal(new Set(calls.map((c) => c.key)).size, 1);
});

test("INV-access: scheduled retention deletes after twelve months and clears only IPs older than thirty days", async () => {
  for (let i = 0; i < 4; i++) assert.deepEqual(await submit("network", { ...network, email: `age${i}@example.org` }), { status: "received" });
  await db.query("UPDATE early_access_request SET created_at = now() - interval '12 months 1 day' WHERE email = 'age0@example.org'");
  await db.query("UPDATE early_access_request SET created_at = now() - interval '31 days' WHERE email = 'age1@example.org'");
  await db.query("UPDATE early_access_request SET created_at = now() - interval '29 days' WHERE email = 'age2@example.org'");
  await db.query("UPDATE early_access_attempt SET created_at = now() - interval '25 hours'");
  assert.deepEqual(await expireAccessRequests(db), { deleted: 1, clearedIps: 1 });
  assert.deepEqual((await db.query("SELECT email, host(ip_address) AS ip FROM early_access_request ORDER BY email")).rows, [
    { email: "age1@example.org", ip: null }, { email: "age2@example.org", ip: "192.0.2.1" }, { email: "age3@example.org", ip: "192.0.2.1" },
  ]);
  assert.equal((await db.query("SELECT count(*)::int AS n FROM early_access_attempt")).rows[0].n, 0);
  assert.deepEqual(await expireAccessRequests(db), { deleted: 0, clearedIps: 0 });
});

test("INV-access: cron requires a configured secret and refuses unauthorized retention", async () => {
  await submit("network", network);
  await db.query("UPDATE early_access_request SET created_at = now() - interval '13 months'");
  delete process.env.CRON_SECRET;
  assert.equal((await GET(new Request("http://localhost/api/cron/access-retention"))).status, 503);
  process.env.CRON_SECRET = "test-cron-secret";
  for (const authorization of ["", "Bearer wrong"]) assert.equal((await GET(new Request("http://localhost/api/cron/access-retention", { headers: { authorization } }))).status, 401);
  assert.equal(await count(), 1);
  const response = await GET(new Request("http://localhost/api/cron/access-retention", { headers: { authorization: "Bearer test-cron-secret" } }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { deleted: 1, clearedIps: 0 });
  assert.equal(await count(), 0);
  delete process.env.CRON_SECRET;
});

test("INV-access: CSV exports all submitted fields and safely quotes punctuation, newlines and formulas", async () => {
  await submit("planter", planter);
  await submit("network", { ...network, name: '=HYPERLINK("x")', message: 'Line 1, "quoted"\nLine 2' });
  const csv = await exportAccessRequests(db);
  const rows = (await db.query("SELECT id, created_at, mailed_at FROM early_access_request ORDER BY created_at, id")).rows;
  assert.equal(csv, 'id,created_at,kind,name,email,plant_name,city,phase,sending,organization,role,plants,message,ip_address,mail_id,mailed_at\r\n' +
    `"${rows[0].id}","${rows[0].created_at.toISOString()}","planter","Sam Planter","sam@example.org","Hope Church","Boston","0 · Discovery","Sending Church","","","","","192.0.2.1","mail-1","${rows[0].mailed_at.toISOString()}"\r\n` +
    `"${rows[1].id}","${rows[1].created_at.toISOString()}","network","'=HYPERLINK(""x"")","alex@example.org","","","","","Network","Director","12","Line 1, ""quoted""\nLine 2","192.0.2.1","mail-2","${rows[1].mailed_at.toISOString()}"\r\n`);
});
