import { randomUUID } from "node:crypto";
import * as c from "@everyfield/contracts/people";
import type { OrganizationPeopleProducer } from "@everyfield/contracts/people";
import {
  authorize,
  canReadPerson,
  deny,
  expected,
  live,
  mutation,
  parse,
  patchPerson,
  person,
  project,
  reply,
  attribution,
} from "./core.ts";
import type { Context, Tx } from "./core.ts";
import { insertPerson, retire, restore } from "./people.ts";
function organization(ctx: Context) {
  if (ctx.selected.kind !== "organization") deny();
  return ctx.selected;
}
export const organizationPeople: OrganizationPeopleProducer<Tx> = {
  async create(tx, ctx, raw) {
    return reply(tx, async () => {
      organization(ctx);
      const input = parse(c.createOrganizationPersonRequest, raw);
      return c.organizationPersonMutationResult.parse(
        await mutation(
          tx,
          ctx,
          "orgPeople.create",
          input,
          async (_actor, id) => {
            const after = await insertPerson(tx, ctx, input.input);
            return {
              value: {
                person: await project(tx, ctx, after),
                receiptId: id,
                outcome: "changed",
                needsOwner: [],
              },
              subject: after.id,
              action: "people.created",
              after,
            };
          },
        ),
      );
    });
  },
  async read(tx, ctx, raw) {
    return reply(tx, async () => {
      organization(ctx);
      const input = parse(c.personRequest, raw);
      await authorize(tx, ctx);
      const p = await person(tx, ctx, input.personId);
      await canReadPerson(tx, ctx, p);
      return c.organizationPerson.parse(await project(tx, ctx, p));
    });
  },
  async update(tx, ctx, raw) {
    return reply(tx, async () => {
      organization(ctx);
      const input = parse(c.updateOrganizationPersonRequest, raw);
      return c.organizationPersonMutationResult.parse(
        await mutation(
          tx,
          ctx,
          "orgPeople.update",
          input,
          async (_actor, id) => {
            const before = await person(tx, ctx, input.input.personId, true);
            live(before);
            expected(before, input.expectedRevision);
            await patchPerson(tx, before.id, input.input.patch);
            const after = await person(tx, ctx, before.id, true);
            return {
              value: {
                person: await project(tx, ctx, after),
                receiptId: id,
                outcome: "changed",
                needsOwner: [],
              },
              subject: before.id,
              action: "people.updated",
              before,
              after,
            };
          },
        ),
      );
    });
  },
  async retire(tx, ctx, raw) {
    return reply(tx, async () => {
      organization(ctx);
      const input = parse(c.retirePersonRequest, raw);
      if (input.input.handoffs.length) deny("invalid_input");
      return c.organizationPersonMutationResult.parse(
        await retire(tx, ctx, input, "orgPeople.retire"),
      );
    });
  },
  async restore(tx, ctx, raw) {
    return reply(tx, async () => {
      organization(ctx);
      return c.organizationPersonMutationResult.parse(
        await restore(
          tx,
          ctx,
          parse(c.restorePersonRequest, raw),
          "orgPeople.restore",
        ),
      );
    });
  },
  async export(tx, ctx, raw) {
    return reply(tx, () => exportPerson(tx, ctx, raw));
  },
  async remove(tx, ctx, raw) {
    return reply(tx, async () => {
      const org = organization(ctx),
        input = parse(c.removeOrganizationPersonRequest, raw);
      if (ctx.purpose !== "native") deny();
      return c.removalResult.parse(
        await mutation(
          tx,
          ctx,
          "orgPeople.remove",
          input,
          async (actor, id) => {
            const before = await person(tx, ctx, input.input.personId, true);
            expected(before, input.expectedRevision);
            const links = await tx.query(
              "SELECT id,affiliation_id FROM residency_link WHERE organization_id=$1 AND person_id=$2 FOR UPDATE",
              [org.id, before.id],
            );
            for (const link of links.rows) {
              await tx.query(
                "UPDATE residency_link SET ended_at=coalesce(ended_at,clock_timestamp()),share_foundations=false,share_milestones=false,consent_revision=consent_revision+1,revision=revision+1 WHERE id=$1",
                [link.id],
              );
              await tx.query(
                "UPDATE affiliation SET ended_at=coalesce(ended_at,clock_timestamp()),revision=revision+1 WHERE id=$1",
                [link.affiliation_id],
              );
            }
            await tx.query(
              "UPDATE invitation SET state=CASE WHEN state='pending' THEN 'revoked' ELSE state END,recipient_email='removed@example.invalid',revision=revision+1 WHERE tenant_id=$1 AND resident_person_id=$2",
              [org.id, before.id],
            );
            await tx.query(
              "UPDATE person_note SET body='',removed_at=coalesce(removed_at,clock_timestamp()),revision=revision+1 WHERE tenant_id=$1 AND person_id=$2",
              [org.id, before.id],
            );
            await tx.query(
              "UPDATE leadership_conversation SET note=NULL,revision=revision+1 WHERE organization_id=$1 AND person_id=$2",
              [org.id, before.id],
            );
            await tx.query(
              "UPDATE pipeline_stage_move SET reason='Removed',revision=revision+1 WHERE organization_id=$1 AND person_id=$2",
              [org.id, before.id],
            );
            // Feedback bodies are not needed to preserve independently owned completions.
            await tx.query(
              `UPDATE assignment_feedback SET body='',withdrawn_at=coalesce(withdrawn_at,clock_timestamp()),revision=revision+1 WHERE organization_id=$1 AND enrollment_milestone_id IN(SELECT m.id FROM enrollment_milestone m JOIN development_enrollment e ON e.id=m.enrollment_id AND e.organization_id=m.organization_id WHERE e.person_id=$2 AND e.organization_id=$1)`,
              [org.id, before.id],
            );
            await tx.query(
              "UPDATE pipeline_person SET assessed_on=NULL,assessor_label=NULL,responsible_seat_id=NULL,revision=revision+1 WHERE organization_id=$1 AND person_id=$2",
              [org.id, before.id],
            );
            const completions = await tx.query(
              "SELECT m.id FROM enrollment_milestone m JOIN development_enrollment e ON e.id=m.enrollment_id AND e.organization_id=m.organization_id WHERE e.organization_id=$1 AND e.person_id=$2 AND m.completed_at IS NOT NULL",
              [org.id, before.id],
            );
            const enrollments = await tx.query(
              "UPDATE development_enrollment SET status=CASE WHEN status='active' THEN 'withdrawn' ELSE status END,cohort_label='',next_meeting_at=NULL,revision=revision+1 WHERE organization_id=$1 AND person_id=$2 RETURNING id",
              [org.id, before.id],
            );
            await tx.query(
              `UPDATE person SET display_name='Former participant',first_name=NULL,last_name=NULL,email=NULL,phone=NULL,street=NULL,city=NULL,state_province=NULL,postal_code=NULL,country=NULL,source_details=NULL,notes=NULL,birth_date=NULL,linked_account_id=NULL,photo_object_id=NULL,state='retired',retired_at=coalesce(retired_at,clock_timestamp()),revision=revision+1 WHERE id=$1`,
              [before.id],
            );
            const after = await person(tx, ctx, before.id, true);
            const witness = (
              await tx.query(
                "INSERT INTO organization_person_removal(id,organization_id,person_record_id,removed_at,requested_by,witness_checkpoint,revision) VALUES($1,$2,$3,clock_timestamp(),$4,$5,$5) RETURNING *",
                [randomUUID(), org.id, before.id, actor, after.revision],
              )
            ).rows[0];
            await tx.query("SELECT purge_organization_person_history($1,$2)", [
              org.id,
              before.id,
            ]);
            const retained = [
              ...(completions.rowCount
                ? [
                    {
                      category: "program_completion",
                      reason: "independent_organization_fact",
                      attribution: "scope_local",
                    },
                  ]
                : []),
              ...(enrollments.rowCount
                ? [
                    {
                      category: "enrollment",
                      reason: "independent_organization_fact",
                      attribution: "scope_local",
                    },
                  ]
                : []),
              ...(links.rowCount
                ? [
                    {
                      category: "relationship_receipt",
                      reason: "revocation_enforcement",
                      attribution: "scope_local",
                    },
                  ]
                : []),
            ];
            // No identifiable pre-removal snapshot or free-text reason is reintroduced.
            return {
              value: {
                witness: {
                  organization: org,
                  personRecordId: before.id,
                  removedAt: witness.removed_at.toISOString(),
                  revision: witness.revision,
                  checkpoint: witness.witness_checkpoint,
                },
                receiptId: id,
                retained,
              },
              subject: before.id,
              action: "people.retired",
              after,
            };
          },
        ),
      );
    });
  },
};
async function exportPerson(tx: Tx, ctx: Context, raw: unknown) {
  const org = organization(ctx);
  if (!["native", "export"].includes(ctx.purpose)) deny();
  const input = parse(c.exportOrganizationPersonRequest, raw);
  const actor = await authorize(tx, ctx, true);
  const p = await person(tx, ctx, input.personId),
    dto = c.organizationPerson.parse(await project(tx, ctx, p));
  const links = await tx.query(
    `SELECT l.consent_revision,l.share_milestones FROM residency_link l JOIN affiliation a ON a.id=l.affiliation_id AND a.organization_id=l.organization_id JOIN invitation i ON i.id=l.invitation_id AND i.tenant_id=l.organization_id WHERE l.organization_id=$1 AND l.person_id=$2 AND l.ended_at IS NULL AND a.ended_at IS NULL AND i.state='accepted' AND NOT EXISTS(SELECT FROM lifecycle_witness w WHERE w.account_id=l.account_id AND w.state NOT IN ('active','cancelled')) FOR SHARE OF l,a,i`,
    [org.id, p.id],
  );
  const link = links.rows[0];
  const history = await tx.query(
    `SELECT m.id,m.to_stage_id,m.moved_at,m.actor_id,m.new_label AS label FROM pipeline_stage_move m JOIN pipeline_stage s ON s.id=m.to_stage_id AND s.organization_id=m.organization_id WHERE m.organization_id=$1 AND m.person_id=$2 ORDER BY m.moved_at,m.id LIMIT 1001`,
    [org.id, p.id],
  );
  const enrollments = await tx.query(
    "SELECT id,program_id,status FROM development_enrollment WHERE organization_id=$1 AND person_id=$2 ORDER BY id LIMIT 1001",
    [org.id, p.id],
  );
  const milestones = await tx.query(
    `SELECT m.* FROM enrollment_milestone m JOIN development_enrollment e ON e.id=m.enrollment_id AND e.organization_id=m.organization_id WHERE e.organization_id=$1 AND e.person_id=$2 AND m.completed_at IS NOT NULL AND (m.completion_source='program_leader_recorded' OR $3) ORDER BY m.id LIMIT 1001 FOR SHARE OF m,e`,
    [org.id, p.id, link?.share_milestones ?? false],
  );
  if ([history, enrollments, milestones].some((r) => r.rows.length > 1000))
    deny("source_unavailable");
  const stageHistory = [];
  for (const h of history.rows)
    stageHistory.push({
      stageId: h.to_stage_id,
      label: h.label,
      occurredAt: h.moved_at.toISOString(),
      actor: await attribution(tx, h.actor_id, org.id + ":" + h.id),
    });
  const completions = [];
  for (const m of milestones.rows)
    completions.push({
      milestoneId: m.milestone_id,
      completedAt: m.completed_at.toISOString(),
      source:
        m.completion_source === "resident_self"
          ? "resident"
          : "program_leader_recorded",
      recordedBy: await attribution(tx, m.completed_by, org.id + ":" + m.id),
      confirmation: m.confirmed_at
        ? {
            status: "confirmed",
            at: m.confirmed_at.toISOString(),
            by: await attribution(tx, m.confirmed_by, org.id + ":" + m.id),
          }
        : { status: "pending" },
    });
  const {
    displayName,
    firstName,
    lastName,
    email,
    phone,
    street,
    city,
    stateProvince,
    postalCode,
    country,
  } = dto;
  await tx.query(
    `INSERT INTO event(tenant_id,target_record_id,actor_id,kind,occurred_at,recorded_at,event_key,action) VALUES($1,$2,$3,'read',clock_timestamp(),clock_timestamp(),$4,'security.bulk_export')`,
    [org.id, p.id, actor.accountId, randomUUID()],
  );
  return c.organizationExport.parse({
    organization: org,
    personId: p.id,
    sourceRevision: p.revision,
    consentRevision: link?.consent_revision ?? null,
    producedAt: new Date().toISOString(),
    contact: {
      displayName,
      firstName,
      lastName,
      email,
      phone,
      street,
      city,
      stateProvince,
      postalCode,
      country,
    },
    stageHistory,
    programs: enrollments.rows.map((e) => ({
      programId: e.program_id,
      status: e.status === "withdrawn" ? "ended" : e.status,
    })),
    completions,
  });
}
// Streaming adapters call this again at download, rather than issuing reusable
// bearer URLs or returning bytes copied before authority/consent changed.
export async function downloadOrganizationExport(
  tx: Tx,
  ctx: Context,
  raw: unknown,
) {
  return reply(tx, async () => {
    const data = await exportPerson(tx, ctx, raw);
    const rows = [
      ["category", "field", "value"],
      ...Object.entries(data.contact).map(([k, v]) => ["contact", k, v ?? ""]),
      ...data.stageHistory.map((h) => ["stage", h.stageId, h.label]),
      ...data.programs.map((p) => ["program", p.programId, p.status]),
      ...data.completions.map((m) => [
        "completion",
        m.milestoneId,
        m.completedAt,
      ]),
    ];
    const escape = (v: unknown) => {
      let s = String(v);
      if (/^[\s\u0000-\u001f]*[=+@-]/.test(s)) s = "'" + s;
      return '"' + s.replaceAll('"', '""') + '"';
    };
    return {
      mediaType: "text/csv; charset=utf-8",
      filename: "person.csv",
      bytes: Buffer.from(
        rows.map((r) => r.map(escape).join(",")).join("\r\n") + "\r\n",
      ),
    };
  });
}
