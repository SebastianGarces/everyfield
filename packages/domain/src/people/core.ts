import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { currentActor } from "../access/session.ts";
import { readPipelinePerson } from "../access/pipeline.ts";
import { isAdministrator } from "../access/policy.ts";
import { owner, revision } from "@everyfield/contracts/common";
import * as c from "@everyfield/contracts/people";
import type {
  PeopleContext,
  PeopleWriteContext,
  PeopleReply,
} from "@everyfield/contracts/people";

export type Tx = PoolClient;
export type Context = PeopleContext;
export type WriteContext = PeopleWriteContext;
export const hash = (v: unknown) =>
  createHash("sha256").update(stable(v)).digest("hex");
function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v !== null && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export class Refusal extends Error {
  readonly code: z.infer<typeof c.peopleError>["code"];
  constructor(code: z.infer<typeof c.peopleError>["code"]) {
    super(code);
    this.code = code;
  }
}
export function deny(code: Refusal["code"] = "unavailable"): never {
  throw new Refusal(code);
}
export async function reply<T>(
  tx: Tx,
  body: () => Promise<T>,
): Promise<PeopleReply<T>> {
  await tx.query("SAVEPOINT people_operation");
  try {
    const value = await body();
    await tx.query("RELEASE SAVEPOINT people_operation");
    return { status: "ok", value };
  } catch (error) {
    await tx.query("ROLLBACK TO SAVEPOINT people_operation");
    await tx.query("RELEASE SAVEPOINT people_operation");
    if (!(error instanceof Refusal)) throw error;
    const retry =
      error.code === "conflict" || error.code === "use_reviewed_unmerge"
        ? "refresh"
        : error.code === "source_unavailable"
          ? "same_request"
          : "never";
    return {
      status: "refused",
      error: c.peopleError.parse({
        code: error.code,
        details: {},
        correlationId: randomUUID(),
        retry,
      }),
    };
  }
}
export function parse<S extends z.ZodType>(
  schema: S,
  raw: unknown,
): z.output<S> {
  const r = schema.safeParse(raw);
  if (!r.success) deny("invalid_input");
  return r.data;
}
export async function authorize(tx: Tx, context: Context, write = false) {
  const actor = await currentActor(tx, context.session, context.selected);
  if (
    actor.status !== "active" ||
    actor.context.kind !== "seat" ||
    !["plant", "organization"].includes(context.selected.kind)
  )
    deny();
  if (write && !isAdministrator(actor)) deny();
  return actor;
}
export async function lockOwner(tx: Tx, context: Context) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,11011))", [
    context.selected.id,
  ]);
  // Serialize writers before currentActor takes shared lifecycle/seat locks.
  // Parent rows are updated only after account and subject locks, matching provisioning.
}
export const personRow = z.object({
  id: z.uuid(),
  tenant_id: z.uuid(),
  plant_id: z.uuid().nullable(),
  organization_id: z.uuid().nullable(),
  display_name: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state_province: z.string().nullable(),
  postal_code: z.string().nullable(),
  country: z.string().nullable(),
  source: c.recruitmentSource,
  source_details: z.string().nullable(),
  notes: z.string().nullable(),
  stage: c.stage.nullable(),
  adult_classification: c.adultClassification.nullable(),
  birth_date: z.date().nullable(),
  commitment_state: z.enum(["active", "withdrawn", "unknown"]).nullable(),
  created_at: z.date(),
  state: z.enum(["live", "retired", "merged"]),
  retired_at: z.date().nullable(),
  merged_into_person_id: z.uuid().nullable(),
  linked_account_id: z.uuid().nullable(),
  revision,
  pipeline_position: z.string().nullable(),
});
export type Person = z.infer<typeof personRow>;
export async function person(
  tx: Tx,
  context: Pick<Context, "selected">,
  id: string,
  lock = false,
): Promise<Person> {
  const r = await tx.query(
    `SELECT p.* FROM person p WHERE p.id=$1 AND p.tenant_id=$2 AND NOT EXISTS(SELECT FROM organization_person_removal w WHERE w.person_record_id=p.id AND w.organization_id=p.tenant_id) ${lock ? "FOR UPDATE OF p" : "FOR SHARE OF p"}`,
    [id, context.selected.id],
  );
  if (!r.rowCount) deny();
  return personRow.parse(r.rows[0]);
}
export async function canReadPerson(tx: Tx, context: Context, p: Person) {
  const a = await authorize(tx, context);
  if (context.selected.kind === "organization" && !isAdministrator(a)) {
    const r = await readPipelinePerson(tx, context.session, context.selected, {
      personId: p.id,
    });
    if (r.status !== "allowed") deny();
  }
  return a;
}
export async function project(tx: Tx, context: Context, p: Person) {
  const base = {
    id: p.id,
    revision: p.revision,
    createdAt: p.created_at.toISOString(),
    displayName: p.display_name,
    firstName: p.first_name,
    lastName: p.last_name,
    email: p.email,
    phone: p.phone,
    street: p.street,
    city: p.city,
    stateProvince: p.state_province,
    postalCode: p.postal_code,
    country: p.country,
    owner: context.selected,
    lifecycle:
      p.state === "live"
        ? { state: "live" }
        : p.state === "retired"
          ? { state: "retired", retiredAt: p.retired_at!.toISOString() }
          : {
              state: "merged",
              retiredAt: p.retired_at!.toISOString(),
              survivorId: p.merged_into_person_id,
            },
  };
  if (context.selected.kind === "organization")
    return c.organizationPerson.parse(base);
  const evidence = await tx.query(
    "SELECT id,kind,signed_on,revision FROM commitment WHERE plant_id=$1 AND person_id=$2 AND voided_at IS NULL ORDER BY signed_on DESC,id DESC LIMIT 1",
    [context.selected.id, p.id],
  );
  const e = evidence.rows[0];
  const commitment =
    p.commitment_state === "unknown" || !e
      ? { state: "unknown" }
      : {
          state: p.commitment_state,
          evidenceId: e.id,
          kind: e.kind,
          occurredOn: e.signed_on.toISOString().slice(0, 10),
          revision: e.revision,
        };
  return c.plantPerson.parse({
    ...base,
    stage: p.stage,
    source: p.source,
    sourceDetails: p.source_details,
    summaryNotes: p.notes,
    adultClassification: p.adult_classification,
    birthDate: p.birth_date?.toISOString().slice(0, 10) ?? null,
    commitment,
  });
}
export const contactColumns = {
  displayName: "display_name",
  firstName: "first_name",
  lastName: "last_name",
  email: "email",
  phone: "phone",
  street: "street",
  city: "city",
  stateProvince: "state_province",
  postalCode: "postal_code",
  country: "country",
  source: "source",
  sourceDetails: "source_details",
  summaryNotes: "notes",
  birthDate: "birth_date",
} as const;
export async function patchPerson(tx: Tx, id: string, patch: object) {
  const pairs = Object.entries(patch).filter(([k]) => k in contactColumns);
  if (!pairs.length) return;
  const columns = new Map<string, string>(Object.entries(contactColumns));
  await tx.query(
    `UPDATE person SET ${pairs.map(([k], i) => `${columns.get(k)}=$${i + 2}`).join(",")},revision=revision+1 WHERE id=$1`,
    [id, ...pairs.map(([, v]) => v)],
  );
}
export type Mutation = { requestKey: string; expectedRevision?: string };
export async function mutation<T>(
  tx: Tx,
  context: WriteContext,
  name: string,
  input: Mutation,
  body: (
    actorId: string,
    operationId: string,
  ) => Promise<{
    value: T;
    subject: string;
    action: string;
    before?: Person;
    after?: Person;
    reason?: string;
    outcome?: "changed" | "noop";
  }>,
): Promise<T> {
  await lockOwner(tx, context);
  const orgNote =
    context.selected.kind === "organization" &&
    ["people.addNote", "people.editNote", "people.deleteNote"].includes(name);
  const actor = await authorize(tx, context, !orgNote);
  if (orgNote) {
    const subject = parse(
      z.object({ input: z.object({ personId: z.uuid() }) }),
      input,
    ).input.personId;
    const access = await readPipelinePerson(
      tx,
      context.session,
      context.selected,
      { personId: subject },
    );
    if (
      context.purpose !== "native" ||
      access.status !== "allowed" ||
      !access.duties.some((d) => d.canReadStaffNotes)
    )
      deny();
  }
  const digest = hash({ name, input, origin: context.origin });
  const prior = await tx.query(
    "SELECT o.id,o.actor_id,o.name,o.request_digest,r.value,r.person_id FROM operation o JOIN people_result r ON r.operation_id=o.id WHERE o.tenant_id=$1 AND o.request_key=$2 FOR UPDATE OF o",
    [context.selected.id, input.requestKey],
  );
  if (prior.rowCount) {
    const r = prior.rows[0];
    if (
      r.actor_id !== actor.accountId ||
      r.name !== name ||
      r.request_digest !== digest
    )
      deny("conflict");
    if (
      name !== "orgPeople.remove" &&
      (
        await tx.query(
          "SELECT id FROM organization_person_removal WHERE organization_id=$1 AND person_record_id=$2",
          [context.selected.id, r.person_id],
        )
      ).rowCount
    )
      deny();
    return r.value;
  }
  if (context.purpose === "model") {
    const o = context.origin;
    const review = await tx.query(
      `SELECT r.id FROM review r JOIN conversation v ON v.id=r.conversation_id AND v.tenant_id=r.tenant_id JOIN effect e ON e.review_id=r.id AND e.tenant_id=r.tenant_id WHERE r.id=$1 AND r.tenant_id=$2 AND r.conversation_id=$3 AND r.digest=$4 AND e.payload_hash=$5 AND e.arguments=$7::jsonb AND e.kind=$8 AND e.state IN ('unstarted','claimed') AND v.owner_id=$6 AND v.state='open' AND r.approved_by_id=$6 AND r.approved_at<=clock_timestamp() AND r.approved_at>clock_timestamp()-interval '15 minutes' AND r.cancelled_at IS NULL AND r.superseded_at IS NULL FOR SHARE OF r,v,e`,
      [
        o.reviewId,
        context.selected.id,
        o.conversationId,
        o.planDigest,
        hash({ name, input }),
        actor.accountId,
        JSON.stringify({ operation: name, input }),
        name,
      ],
    );
    if (!review.rowCount) deny();
  }
  const operationId = randomUUID();
  const result = await body(actor.accountId, operationId);
  const outcome = result.outcome ?? "changed";
  await tx.query(
    `INSERT INTO operation(id,tenant_id,actor_id,name,request_key,request_digest,review_id,conversation_id,state,outcome,started_at,completed_at,tool_calls,reserved_input,reserved_output,used_input,used_output) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'complete',$9,clock_timestamp(),clock_timestamp(),0,0,0,0,0)`,
    [
      operationId,
      context.selected.id,
      actor.accountId,
      name,
      input.requestKey,
      digest,
      context.origin.kind === "assistant" ? context.origin.reviewId : null,
      context.origin.kind === "assistant"
        ? context.origin.conversationId
        : null,
      outcome === "noop" ? "no_effect" : "committed",
    ],
  );
  await tx.query(
    "INSERT INTO people_result(operation_id,person_id,value) VALUES($1,$2,$3)",
    [
      operationId,
      result.subject === context.selected.id ? null : result.subject,
      JSON.stringify(result.value),
    ],
  );
  // Domain history can carry operational bodies; the central audit never does.
  if (result.subject !== context.selected.id)
    await tx.query(
      `INSERT INTO people_history(tenant_id,person_id,operation_id,actor_id,actor_token,action,occurred_at,before_revision,after_revision,before_value,after_value,reason) VALUES($1,$2,$3,$4,$5,$6,clock_timestamp(),$7,$8,$9,$10,$11)`,
      [
        context.selected.id,
        result.subject,
        operationId,
        actor.accountId,
        hash([context.selected.id, actor.accountId]),
        result.action,
        result.before?.revision ?? null,
        result.after?.revision ?? result.before?.revision ?? "1",
        result.before ? JSON.stringify(result.before) : null,
        result.after ? JSON.stringify(result.after) : null,
        result.reason ?? null,
      ],
    );
  await tx.query(
    `INSERT INTO event(tenant_id,target_record_id,operation_id,actor_id,kind,occurred_at,recorded_at,before_revision,after_revision,event_key,action) VALUES($1,$2,$3,$4,$5,clock_timestamp(),clock_timestamp(),$6,$7,$3::uuid::text,$8)`,
    [
      context.selected.id,
      result.subject,
      operationId,
      actor.accountId,
      outcome === "noop"
        ? "noop"
        : result.action === "people.created"
          ? "create"
          : result.action === "people.retired"
            ? "retire"
            : result.action === "people.restored"
              ? "restore"
              : "edit",
      result.before?.revision ?? null,
      result.after?.revision ?? result.before?.revision ?? "1",
      result.action,
    ],
  );
  if (outcome === "changed")
    await tx.query(
      `UPDATE ${context.selected.kind === "plant" ? "plant" : "organization"} SET material_revision=material_revision+1 WHERE id=$1`,
      [context.selected.id],
    );
  return result.value;
}
export function expected(p: Person, revision: string) {
  if (p.revision !== revision) deny("conflict");
}
export function live(p: Person) {
  if (p.state !== "live") deny();
}
export async function attribution(
  tx: Tx,
  actorId: string | null,
  token: string,
) {
  if (actorId) {
    const a = await tx.query("SELECT id FROM account WHERE id=$1", [actorId]);
    if (a.rowCount) return { kind: "current_account", accountId: actorId };
  }
  return { kind: "former_account", scopeLocalToken: token };
}
export { owner };
