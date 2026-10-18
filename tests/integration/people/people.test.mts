import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  migrate,
  migrationArtifact,
} from "../../../packages/db/src/schema/migrate.ts";
import {
  peopleWriter as write,
  peopleReader as read,
  organizationPeople as org,
  accountPersonProducer as accounts,
  getAccountLink,
  downloadOrganizationExport,
} from "../../../packages/domain/src/people/index.ts";
const require = createRequire(
    new URL("../../../packages/domain/package.json", import.meta.url),
  ),
  { Pool } = require("pg");
const source = new URL(
  process.env.DATABASE_URL_UNPOOLED ??
    process.env.DATABASE_URL ??
    "about:blank",
);
if (
  source.hostname !== "ep-autumn-dew-b8ltidky.c-14.us-east-1.aws.neon.tech" ||
  process.env.NODE_ENV === "production"
)
  throw Error("Only approved shared development direct endpoint allowed");
source.searchParams.set("sslmode", "verify-full");
const schema = "wp011_" + randomUUID().replaceAll("-", ""),
  role = "wp011_" + randomBytes(8).toString("hex");
const admin = new Pool({
  connectionString: source.href,
  max: 6,
  options: `-c search_path=${schema},pg_catalog,pg_temp`,
});
let db;
const plants = [randomUUID(), randomUUID()],
  organization = randomUUID(),
  actors = Array.from({ length: 5 }, () => ({
    id: randomUUID(),
    user: randomUUID(),
    session: randomUUID(),
  }));
const ctx = (who = 0, selected = { kind: "plant", id: plants[0] }) => ({
  session: actors[who].session,
  selected,
  purpose: "native",
  origin: { kind: "native" },
});
const orgCtx = () =>
  ctx(3, {
    kind: "organization",
    id: organization,
    organizationKind: "sending_church",
  });
const ok = (result) => {
  assert.equal(result.status, "ok", JSON.stringify(result));
  return result.value;
};
const refused = (result, code = "unavailable") => {
  assert.equal(result.status, "refused", JSON.stringify(result));
  assert.equal(result.error.code, code);
};
async function tx(body) {
  const c = await db.connect();
  try {
    await c.query("BEGIN");
    const r = await body(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
async function create(name = "Jamie", fields = {}) {
  return ok(
    await tx((t) =>
      write.createPerson(t, ctx(), {
        requestKey: randomUUID(),
        input: { displayName: name, ...fields },
      }),
    ),
  ).person;
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(admin, schema);
  const password = randomBytes(32).toString("hex");
  await admin.query(
    `CREATE ROLE ${role} LOGIN INHERIT PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
  );
  await admin.query(`GRANT everyfield_runtime TO ${role}`);
  const url = new URL(source);
  url.username = role;
  url.password = password;
  db = new Pool({
    connectionString: url.href,
    max: 6,
    options: `-c search_path=${schema},pg_catalog,pg_temp`,
  });
  for (const a of actors) {
    await admin.query(
      "INSERT INTO auth_user(id,email,email_verified,name) VALUES($1,$2,true,'Synthetic')",
      [a.user, a.id + "@example.test"],
    );
    await admin.query(
      "INSERT INTO account(id,auth_user_id,registration_state,registration_kind) VALUES($1,$2,'active','planter')",
      [a.id, a.user],
    );
    await admin.query(
      "INSERT INTO auth_session(id,user_id,token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 day')",
      [a.session, a.user, randomUUID()],
    );
  }
  for (const id of plants)
    await admin.query(
      "INSERT INTO plant(id,name,timezone,warning_days,alert_days,digest_weekday,digest_hour,phase,material_revision) VALUES($1,'Synthetic','America/New_York',7,14,1,8,1,1)",
      [id],
    );
  await admin.query(
    "INSERT INTO organization(id,kind,name,timezone,material_revision) VALUES($1,'sending_church','Synthetic','America/New_York',1)",
    [organization],
  );
  for (const [i, plant, organizationId, roleName] of [
    [0, plants[0], null, "owner"],
    [1, plants[0], null, "member"],
    [2, plants[1], null, "admin"],
    [3, null, organization, "owner"],
    [4, plants[0], null, "admin"],
  ])
    await admin.query(
      "INSERT INTO seat(account_id,plant_id,organization_id,role,accepted_at) VALUES($1,$2,$3,$4,clock_timestamp())",
      [actors[i].id, plant, organizationId, roleName],
    );
});
after(async () => {
  await db?.end();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
  } finally {
    await admin.end();
  }
});

test("AC:TARGET-PPL-002 AC:WP011-KNOW-099 AC:WP011-KNOW-069 AC:SEC-02 AC:TEN-002 minimal contact, explicit null, current tenancy and atomic retry", async () => {
  const input = {
    requestKey: randomUUID(),
    input: {
      displayName: "  Jamie  ",
      city: "Chicago",
      summaryNotes: "Operational",
    },
  };
  const first = ok(await tx((t) => write.createPerson(t, ctx(), input))),
    again = ok(await tx((t) => write.createPerson(t, ctx(), input)));
  assert.deepEqual(again, first);
  assert.equal(first.person.displayName, "Jamie");
  assert.equal(first.person.adultClassification, "unknown");
  assert.deepEqual(first.person.commitment, { state: "unknown" });
  assert.equal(first.person.firstName, null);
  const changed = ok(
    await tx((t) =>
      write.updatePerson(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: first.person.revision,
        input: { personId: first.person.id, patch: { city: null } },
      }),
    ),
  );
  assert.equal(changed.person.city, null);
  refused(
    await tx((t) =>
      write.updatePerson(t, ctx(1), {
        requestKey: randomUUID(),
        expectedRevision: changed.person.revision,
        input: { personId: first.person.id, patch: { displayName: "forged" } },
      }),
    ),
  );
  refused(
    await tx((t) => read.getPerson(t, ctx(2), { personId: first.person.id })),
  );
  refused(
    await tx((t) => read.getPerson(t, ctx(2), { personId: randomUUID() })),
  );
  assert.equal(
    ok(
      await tx((t) => read.getPerson(t, ctx(1), { personId: first.person.id })),
    ).person.displayName,
    "Jamie",
  );
  const event = (
    await admin.query(
      "SELECT actor_id,reason,diff FROM event WHERE operation_id=$1",
      [changed.receiptId],
    )
  ).rows[0];
  assert.equal(event.actor_id, actors[0].id);
  assert.equal(event.reason, null);
  assert.equal(event.diff, null);
  assert.equal(
    (
      await admin.query("SELECT tenant_id FROM person WHERE id=$1", [
        first.person.id,
      ])
    ).rows[0].tenant_id,
    plants[0],
  );
  const n = (await admin.query("SELECT count(*)::int AS n FROM person")).rows[0]
    .n;
  await assert.rejects(
    tx(async (t) => {
      ok(
        await write.createPerson(t, ctx(), {
          requestKey: randomUUID(),
          input: { displayName: "rollback" },
        }),
      );
      throw Error("required_intent_fault");
    }),
    /required_intent_fault/,
  );
  assert.equal(
    (await admin.query("SELECT count(*)::int AS n FROM person")).rows[0].n,
    n,
  );
  await admin.query(
    "UPDATE seat SET ended_at=clock_timestamp() WHERE account_id=$1",
    [actors[4].id],
  );
  refused(await tx((t) => write.createPerson(t, ctx(4), input)));
  await admin.query("UPDATE seat SET ended_at=NULL WHERE account_id=$1", [
    actors[4].id,
  ]);
});

test("AC:TARGET-PPL-001 literal search, tag intersection, full totals and bound tie cursors", async () => {
  const a = await create("Literal %_ person"),
    b = await create("Literal %_ person 2");
  await admin.query(
    "UPDATE person SET created_at='2026-10-01T12:00:00Z' WHERE id=ANY($1)",
    [[a.id, b.id]],
  );
  const req = { search: "%_", limit: 1 };
  const page = ok(await tx((t) => read.listPeople(t, ctx(1), req)));
  assert.equal(page.total, 2);
  assert.equal(page.items.length, 1);
  assert.ok(page.next);
  const second = ok(
    await tx((t) => read.listPeople(t, ctx(1), { ...req, after: page.next })),
  );
  assert.equal(second.items.length, 1);
  assert.notEqual(second.items[0].id, page.items[0].id);
  assert.equal(second.next, null);
  refused(
    await tx((t) =>
      read.listPeople(t, ctx(1), {
        search: "Literal",
        limit: 1,
        after: page.next,
      }),
    ),
    "invalid_input",
  );
  refused(
    await tx((t) => read.listPeople(t, ctx(2), { ...req, after: page.next })),
    "invalid_input",
  );
  refused(
    await tx((t) =>
      read.listPeople(t, ctx(), { search: "Literal", privateNote: "CANARY" }),
    ),
    "invalid_input",
  );
  const tags = [randomUUID(), randomUUID()];
  for (const [i, id] of tags.entries())
    await admin.query(
      "INSERT INTO tag(id,plant_id,name,color) VALUES($1,$2,$3,'blue')",
      [id, plants[0], "tag" + i],
    );
  for (const [person, tag] of [
    [a.id, tags[0]],
    [a.id, tags[1]],
    [b.id, tags[0]],
  ])
    await admin.query(
      "INSERT INTO person_tag(person_id,plant_id,tag_id) VALUES($1,$2,$3)",
      [person, plants[0], tag],
    );
  const tagged = ok(await tx((t) => read.listPeople(t, ctx(), { tags })));
  assert.deepEqual(
    tagged.items.map((p) => p.id),
    [a.id],
  );
});

test("AC:TARGET-PPL-004 AC:ROLE43-003 AC:CA014 exact account links, ambiguous contact selection and concurrent uniqueness", async () => {
  const contact = await create("Proven account", {
      email: actors[0].id + "@example.test",
    }),
    duplicate = await create("Another contact", {
      email: actors[0].id + "@example.test",
    });
  const input = {
    accountId: actors[0].id,
    owner: ctx().selected,
    selection: { kind: "resolve" },
  };
  const needs = ok(await tx((t) => accounts.ensureAccountPerson(t, input)));
  assert.equal(needs.status, "needs_selection");
  assert.deepEqual(
    new Set(needs.candidatePersonIds),
    new Set([contact.id, duplicate.id]),
  );
  const selected = {
    ...input,
    selection: {
      kind: "reviewed_contact",
      person: {
        owner: ctx().selected,
        personId: contact.id,
        revision: contact.revision,
        state: "live",
      },
    },
  };
  const results = await Promise.all([
    tx((t) => accounts.ensureAccountPerson(t, selected)),
    tx((t) => accounts.ensureAccountPerson(t, selected)),
  ]);
  for (const r of results) assert.equal(ok(r).personId, contact.id);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM person WHERE linked_account_id=$1 AND plant_id=$2 AND state='live'",
        [actors[0].id, plants[0]],
      )
    ).rows[0].n,
    1,
  );
  assert.deepEqual(
    ok(await tx((t) => getAccountLink(t, ctx(), { personId: contact.id }))),
    { status: "linked", personId: contact.id },
  );
  assert.deepEqual(
    ok(await tx((t) => read.getOwnAccountPerson(t, ctx(), {}))),
    { status: "linked", personId: contact.id },
  );
  const dto = ok(
    await tx((t) => read.getPerson(t, ctx(), { personId: contact.id })),
  ).person;
  assert.equal("linkedAccountId" in dto, false);
  assert.deepEqual(dto.commitment, { state: "unknown" });
  await tx((t) =>
    write.updatePerson(t, ctx(), {
      requestKey: randomUUID(),
      expectedRevision: dto.revision,
      input: { personId: contact.id, patch: { email: "crm@example.test" } },
    }),
  );
  assert.equal(
    ok(await tx((t) => read.getOwnAccountPerson(t, ctx(), {}))).personId,
    contact.id,
  );
});

test("AC:WP011-KNOW-098 named guest and explicit selection share the caller transaction", async () => {
  const guest = ok(
    await tx((t) =>
      accounts.ensureGuest(t, ctx(), { kind: "new", displayName: "Guest" }),
    ),
  );
  assert.equal(
    ok(
      await tx((t) =>
        accounts.ensureGuest(t, ctx(), {
          kind: "existing",
          personId: guest.personId,
        }),
      ),
    ).personId,
    guest.personId,
  );
  const n = (await admin.query("SELECT count(*)::int n FROM person")).rows[0].n;
  await assert.rejects(
    tx(async (t) => {
      ok(
        await accounts.ensureGuest(t, ctx(), {
          kind: "new",
          displayName: "Attendance rollback",
        }),
      );
      throw Error("attendance_fault");
    }),
    /attendance_fault/,
  );
  assert.equal(
    (await admin.query("SELECT count(*)::int n FROM person")).rows[0].n,
    n,
  );
});

test("AC:TARGET-PPL-006 AC:TARGET-PPL-007 AC:TARGET-PPL-003 stage skip, no-op, complete handoffs, retirement and guarded restore", async () => {
  let p = await create("Lifecycle");
  let result = ok(
    await tx((t) =>
      write.changeStatus(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: p.revision,
        input: {
          personId: p.id,
          stage: "leader",
          reason: "Human chose a skip",
          handoffs: [],
        },
      }),
    ),
  );
  p = result.person;
  assert.equal(p.stage, "leader");
  assert.deepEqual(p.commitment, { state: "unknown" });
  const noop = ok(
    await tx((t) =>
      write.changeStatus(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: p.revision,
        input: {
          personId: p.id,
          stage: "leader",
          reason: "Same stage",
          handoffs: [],
        },
      }),
    ),
  );
  assert.equal(noop.outcome, "noop");
  assert.equal(noop.person.revision, p.revision);
  const duty = randomUUID();
  await admin.query(
    "INSERT INTO task(id,plant_id,title,category,priority,status,created_at,assignee_id,due_kind,person_id) VALUES($1,$2,'Call','follow_up','medium','not_started',clock_timestamp(),$4,'undated',$3)",
    [duty, plants[0], p.id, actors[0].id],
  );
  refused(
    await tx((t) =>
      write.retirePerson(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: p.revision,
        input: {
          personId: p.id,
          reason: "Retire",
          reviewRevision: review,
          handoffs: [],
        },
      }),
    ),
    "conflict",
  );
  const review = ok(
    await tx((t) => read.getStatusWarnings(t, ctx(), { personId: p.id })),
  ).reviewRevision;
  const retired = ok(
    await tx((t) =>
      write.retirePerson(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: p.revision,
        input: {
          personId: p.id,
          reason: "Retire",
          reviewRevision: review,
          handoffs: [
            { kind: "needs_owner", dutyId: duty, expectedRevision: "1" },
          ],
        },
      }),
    ),
  );
  assert.deepEqual(retired.needsOwner, [duty]);
  assert.equal(retired.person.lifecycle.state, "retired");
  assert.equal(
    ok(await tx((t) => read.listPeople(t, ctx(), { search: "Lifecycle" })))
      .total,
    0,
  );
  await assert.rejects(
    admin.query(
      "INSERT INTO task(plant_id,title,category,priority,status,created_at,due_kind,person_id) VALUES($1,'New','follow_up','medium','not_started',clock_timestamp(),'undated',$2)",
      [plants[0], p.id],
    ),
    /person_not_live/,
  );
  const restored = ok(
    await tx((t) =>
      write.restorePerson(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: retired.person.revision,
        input: { personId: p.id },
      }),
    ),
  );
  assert.equal(restored.person.lifecycle.state, "live");
  const warnings = ok(
    await tx((t) => read.getStatusWarnings(t, ctx(), { personId: p.id })),
  );
  assert.equal(warnings.hardGate, false);
  assert.equal(warnings.allowedStages.length, 7);
  const pipeline = ok(await tx((t) => read.getPipelineData(t, ctx(1), {})));
  assert.equal(pipeline.groups.length, 5);
  assert.ok(
    pipeline.groups
      .find((g) => g.column === "core_group")
      .cards.some((card) => card.person.id === p.id),
  );
  const empty = ok(
    await tx((t) =>
      write.reorderPipeline(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: "1",
        input: { column: "prospect", personIds: [] },
      }),
    ),
  );
  assert.equal(empty.outcome, "noop");
  const survivor = await create("Survivor");
  await admin.query(
    "UPDATE person SET state='merged',merged_into_person_id=$2,retired_at=clock_timestamp() WHERE id=$1",
    [p.id, survivor.id],
  );
  refused(
    await tx((t) =>
      write.restorePerson(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: restored.person.revision,
        input: { personId: p.id },
      }),
    ),
    "use_reviewed_unmerge",
  );
});

test("AC:TARGET-PPL-008 original author and exact note revisions preserve occurrence, tombstone and removed attribution", async () => {
  const p = await create("Notes");
  const added = ok(
    await tx((t) =>
      write.addNote(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: p.revision,
        input: { personId: p.id, body: "Original operational note" },
      }),
    ),
  );
  const before = (
    await admin.query(
      "SELECT occurred_at,author_id FROM person_note WHERE id=$1",
      [added.noteId],
    )
  ).rows[0];
  refused(
    await tx((t) =>
      write.editNote(t, ctx(4), {
        requestKey: randomUUID(),
        expectedRevision: added.revision,
        input: {
          personId: p.id,
          noteId: added.noteId,
          body: "Not mine",
          reason: "Edit",
        },
      }),
    ),
  );
  const edited = ok(
    await tx((t) =>
      write.editNote(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: added.revision,
        input: {
          personId: p.id,
          noteId: added.noteId,
          body: "Corrected operational note",
          reason: "Correction",
        },
      }),
    ),
  );
  assert.deepEqual(
    (
      await admin.query(
        "SELECT occurred_at,author_id FROM person_note WHERE id=$1",
        [added.noteId],
      )
    ).rows[0],
    before,
  );
  const timeline = ok(
    await tx((t) =>
      read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"] }),
    ),
  );
  assert.equal(timeline.items[0].body, "Corrected operational note");
  const deleted = ok(
    await tx((t) =>
      write.deleteNote(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: edited.revision,
        input: { personId: p.id, noteId: added.noteId, reason: "Remove body" },
      }),
    ),
  );
  assert.equal(deleted.revision, "3");
  assert.equal(
    (
      await admin.query("SELECT body FROM person_note WHERE id=$1", [
        added.noteId,
      ])
    ).rows[0].body,
    "",
  );
  assert.equal(
    ok(
      await tx((t) =>
        read.getActivities(t, ctx(), { personId: p.id, kinds: ["note"] }),
      ),
    ).items[0].kind,
    "note_removed",
  );
});

test("AC:ADR1-001 AC:WP011-MUL-001 AC:ADR1-005 AC:WP011-MUL-005 organization projection, safe fresh downloads and immediate removal", async () => {
  const request = {
    requestKey: randomUUID(),
    input: { displayName: "=2+3", email: "contact@example.test" },
  };
  const created = ok(await tx((t) => org.create(t, orgCtx(), request)));
  assert.equal("stage" in created.person, false);
  assert.equal("adultClassification" in created.person, false);
  const p = created.person;
  refused(await tx((t) => read.getPerson(t, ctx(), { personId: p.id })));
  const exp = { personId: p.id, format: "csv" };
  const data = ok(await tx((t) => org.export(t, orgCtx(), exp)));
  assert.equal(data.contact.displayName, "=2+3");
  assert.equal("notes" in data, false);
  const csv = ok(await tx((t) => downloadOrganizationExport(t, orgCtx(), exp)));
  assert.match(csv.bytes.toString(), /"'=2\+3"/);
  const retired = ok(
    await tx((t) =>
      org.retire(t, orgCtx(), {
        requestKey: randomUUID(),
        expectedRevision: p.revision,
        input: {
          personId: p.id,
          reviewRevision: p.revision,
          reason: "Retire",
          handoffs: [],
        },
      }),
    ),
  );
  assert.equal(retired.person.lifecycle.state, "retired");
  const restored = ok(
    await tx((t) =>
      org.restore(t, orgCtx(), {
        requestKey: randomUUID(),
        expectedRevision: retired.person.revision,
        input: { personId: p.id },
      }),
    ),
  );
  const removed = ok(
    await tx((t) =>
      org.remove(t, orgCtx(), {
        requestKey: randomUUID(),
        expectedRevision: restored.person.revision,
        input: { personId: p.id, reason: "Person requested removal" },
      }),
    ),
  );
  assert.equal(removed.witness.personRecordId, p.id);
  assert.equal("cancelUntil" in removed, false);
  refused(await tx((t) => downloadOrganizationExport(t, orgCtx(), exp)));
  refused(await tx((t) => org.read(t, orgCtx(), { personId: p.id })));
  refused(await tx((t) => org.create(t, orgCtx(), request)));
  const row = (
    await admin.query(
      "SELECT display_name,email,notes,linked_account_id FROM person WHERE id=$1",
      [p.id],
    )
  ).rows[0];
  assert.deepEqual(row, {
    display_name: "Former participant",
    email: null,
    notes: null,
    linked_account_id: null,
  });
  const history = (
    await admin.query(
      "SELECT before_value,after_value,reason FROM people_history WHERE person_id=$1",
      [p.id],
    )
  ).rows;
  assert.ok(history.every((h) => h.before_value === null && h.reason === null));
  assert.equal(JSON.stringify(history).includes("contact@example.test"), false);
});

test("AC:TARGET-PPL-023 AC:GAP-PPL-023 distinct transition units preserve repeated historical moves and unknown denominators", async () => {
  let p = await create("Metrics");
  for (const stage of ["attendee", "prospect", "attendee"])
    p = ok(
      await tx((t) =>
        write.changeStatus(t, ctx(), {
          requestKey: randomUUID(),
          expectedRevision: p.revision,
          input: {
            personId: p.id,
            stage,
            reason: "Recorded move",
            handoffs: [],
          },
        }),
      ),
    ).person;
  const now = new Date().toISOString(),
    day = now.slice(0, 10);
  const metrics = ok(
    await tx((t) =>
      read.readPipelineMetrics(t, ctx(), {
        asOf: now,
        from: day,
        through: day,
      }),
    ),
  );
  assert.equal(metrics.unit, "distinct_canonical_people");
  assert.equal(
    metrics.transitions.find((t) => t.from === "prospect").distinctPeople >= 1,
    true,
  );
  assert.equal(metrics.currentStages.length, 7);
  assert.equal(metrics.transitions[0].conversion.status, "unknown");
  refused(
    await tx((t) =>
      read.readPipelineMetrics(
        t,
        { ...ctx(), purpose: "model" },
        { asOf: now, from: day, through: day },
      ),
    ),
  );
  const artifact = await migrationArtifact();
  assert.ok(artifact.every((m) => /^[a-f0-9]{64}$/.test(m.sha256)));
  assert.deepEqual(await migrate(admin, schema), []);
});

test("AC:CA014 explicit adult classification retains genuine historical acquisition rather than creating a join today", async () => {
  const p = await create("Historical commitment");
  const commitment = randomUUID();
  await admin.query(
    "INSERT INTO commitment(id,plant_id,person_id,kind,signed_on,recorded_at) VALUES($1,$2,$3,'core_group','2026-09-01',clock_timestamp())",
    [commitment, plants[0], p.id],
  );
  await admin.query("UPDATE person SET commitment_state='active' WHERE id=$1", [
    p.id,
  ]);
  const result = ok(
    await tx((t) =>
      write.recordAdultClassification(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: p.revision,
        input: {
          personId: p.id,
          classification: "adult",
          occurredOn: "2026-10-13",
          reason: "Human recorded classification",
        },
      }),
    ),
  );
  assert.equal(result.observation.classification, "adult");
  assert.equal(result.observation.current.state, "active");
  assert.equal(result.observation.firstAcquisition.occurredOn, "2026-09-01");
  assert.equal(result.observation.firstAcquisition.evidenceId, commitment);
  const before = (
    await admin.query("SELECT signed_on FROM commitment WHERE id=$1", [
      commitment,
    ])
  ).rows[0].signed_on;
  const corrected = ok(
    await tx((t) =>
      write.correctAdultClassification(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: result.observation.sourceRevision,
        input: {
          personId: p.id,
          classification: "unknown",
          occurredOn: "2026-10-13",
          reason: "Correct unsupported classification",
        },
      }),
    ),
  );
  assert.equal(corrected.observation.classification, "unknown");
  assert.equal(corrected.observation.current.state, "active");
  assert.deepEqual(
    (
      await admin.query("SELECT signed_on FROM commitment WHERE id=$1", [
        commitment,
      ])
    ).rows[0].signed_on,
    before,
  );
});

test("INV-people: concurrent edits serialize to one current revision and one conflict without partial history", async () => {
  const p = await create("Concurrent");
  const change = (name) =>
    tx((t) =>
      write.updatePerson(t, ctx(), {
        requestKey: randomUUID(),
        expectedRevision: p.revision,
        input: { personId: p.id, patch: { displayName: name } },
      }),
    );
  const results = await Promise.all([change("Winner A"), change("Winner B")]);
  assert.equal(results.filter((r) => r.status === "ok").length, 1);
  const failure = results.find((r) => r.status !== "ok");
  refused(failure, "conflict");
  const row = ok(
    await tx((t) => read.getPerson(t, ctx(), { personId: p.id })),
  ).person;
  assert.equal(BigInt(row.revision), BigInt(p.revision) + 1n);
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int n FROM people_history WHERE person_id=$1 AND action='people.updated'",
        [p.id],
      )
    ).rows[0].n,
    1,
  );
});

test("INV-people: reviewed assistant writes bind the exact actor, arguments, current review and fresh revision", async () => {
  const { hash } = await import("../../../packages/domain/src/people/core.ts");
  const p = await create("Reviewed"),
    input = {
      requestKey: randomUUID(),
      expectedRevision: p.revision,
      input: { personId: p.id, patch: { displayName: "Reviewed change" } },
    },
    name = "people.updatePerson";
  const conversation = randomUUID(),
    review = randomUUID(),
    effect = randomUUID(),
    digest = "b".repeat(64);
  await admin.query(
    "INSERT INTO conversation(id,tenant_id,owner_id,title,state) VALUES($1,$2,$3,'Synthetic review','open')",
    [conversation, plants[0], actors[0].id],
  );
  await admin.query(
    "INSERT INTO review(id,tenant_id,conversation_id,proposal_number,digest,effect_manifest_hash,published_at,approved_by_id,approved_at,witness_hash) VALUES($1,$2,$3,1,$4,$5,clock_timestamp(),$6,clock_timestamp(),$5)",
    [
      review,
      plants[0],
      conversation,
      digest,
      hash({ name, input }),
      actors[0].id,
    ],
  );
  await admin.query(
    "INSERT INTO effect(id,tenant_id,review_id,effect_key,kind,payload_hash,state,arguments) VALUES($1,$2,$3,'people-effect',$4,$5,'unstarted',$6)",
    [
      effect,
      plants[0],
      review,
      name,
      hash({ name, input }),
      JSON.stringify({ operation: name, input }),
    ],
  );
  const model = {
    ...ctx(),
    purpose: "model",
    origin: {
      kind: "assistant",
      reviewId: review,
      conversationId: conversation,
      planDigest: digest,
    },
  };
  refused(
    await tx((t) =>
      write.updatePerson(t, model, {
        ...input,
        input: { ...input.input, patch: { displayName: "Forged effects" } },
      }),
    ),
  );
  const changed = ok(await tx((t) => write.updatePerson(t, model, input)));
  assert.equal(changed.person.displayName, "Reviewed change");
  await admin.query(
    "UPDATE review SET approved_at=clock_timestamp()-interval '16 minutes' WHERE id=$1",
    [review],
  );
  assert.deepEqual(
    ok(await tx((t) => write.updatePerson(t, model, input))),
    changed,
  );
  refused(
    await tx((t) =>
      write.updatePerson(t, model, {
        ...input,
        requestKey: randomUUID(),
        expectedRevision: changed.person.revision,
      }),
    ),
  );
});
