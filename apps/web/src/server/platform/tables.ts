// Synthetic WP-003 proof schema. Excluded from application migrations.
import { pgTable, text, uuid, boolean, integer, timestamp, bigint, customType, primaryKey, unique, check, index } from "@everyfield/db/columns";
import { sql } from "@everyfield/db/query";
const int64=customType<{data:string;driverData:string}>({dataType:()=>"bigint"});
export const proof_grant = pgTable("proof_grant", {
  account_id: text("account_id").notNull(),
  owner_id: uuid("owner_id").notNull(),
  role: text("role", {enum:["owner","admin"]}).notNull(),
  active: boolean("active").notNull().default(sql`(true)`),
}, t=>[check("proof_grant_role_check",sql`(role IN (('owner'), ('admin')))`),
primaryKey({columns:[t.account_id,t.owner_id]})]);
export const proof_subject = pgTable("proof_subject", {
  id: uuid("id").notNull().primaryKey(),
  owner_id: uuid("owner_id").notNull(),
  value: text("value").notNull().default(sql`('original')`),
  revision: int64("revision").notNull().default(sql`(1)`),
  active: boolean("active").notNull().default(sql`(true)`),
});
export const proof_audit = pgTable("proof_audit", {
  id: uuid("id").notNull().primaryKey().default(sql`(gen_random_uuid () )`),
  subject: uuid("subject").notNull().references(()=>proof_subject.id),
  revision: int64("revision").notNull(),
});
export const proof_receipt = pgTable("proof_receipt", {
  id: uuid("id").notNull().primaryKey().default(sql`(gen_random_uuid () )`),
  subject: uuid("subject").notNull().references(()=>proof_subject.id),
  revision: int64("revision").notNull(),
});
export const proof_intent = pgTable("proof_intent", {
  id: uuid("id").notNull().primaryKey().default(sql`(gen_random_uuid () )`),
  subject: uuid("subject").notNull().references(()=>proof_subject.id),
  revision: int64("revision").notNull(),
});
export const proof_rate = pgTable("proof_rate", {
  key: text("key").notNull(),
  at: timestamp("at", {withTimezone:true,mode:"date"}).notNull().default(sql`(clock_timestamp () )`),
}, t=>[index("proof_rate_key_at_idx").on(t.key,t.at)]);
export const proof_object = pgTable("proof_object", {
  id: uuid("id").notNull().primaryKey(),
  owner_id: uuid("owner_id").notNull(),
  object_key: text("object_key").notNull().unique(),
  format: text("format", {enum:["docx","xlsx","pdf"]}).notNull(),
  checksum: text("checksum").notNull(),
  bytes: integer("bytes").notNull(),
  state: text("state", {enum:["pending","ready","deleted"]}).notNull().default(sql`('pending')`),
  preview: text("preview"),
}, t=>[check("proof_object_format_check",sql`(format IN (('docx'), ('xlsx'), ('pdf')))`),
check("proof_object_state_check",sql`(state IN (('pending'), ('ready'), ('deleted')))`)]);
export const proof_stream = pgTable("proof_stream", {
  id: bigint("id", {mode:"number"}).notNull().primaryKey().generatedAlwaysAsIdentity(),
  owner_id: uuid("owner_id").notNull(),
  status: text("status", {enum:["ready","succeeded","reconcile"]}).notNull(),
}, t=>[check("proof_stream_status_check",sql`(status IN (('ready'), ('succeeded'), ('reconcile')))`)]);
export const proof_job = pgTable("proof_job", {
  id: uuid("id").notNull().primaryKey().default(sql`(gen_random_uuid () )`),
  kind: text("kind").notNull(),
  subject: uuid("subject").notNull().references(()=>proof_subject.id),
  producer_key: text("producer_key").notNull(),
  revision: int64("revision").notNull(),
  generation: int64("generation").notNull().default(sql`(0)`),
  worker: uuid("worker"),
  lease_until: timestamp("lease_until", {withTimezone:true,mode:"date"}),
  state: text("state", {enum:["ready","claimed","retry_wait","reconcile","succeeded","failed","cancelled","superseded"]}).notNull().default(sql`('ready')`),
  attempts: integer("attempts").notNull().default(sql`(0)`),
  checkpoint: text("checkpoint"),
}, t=>[check("proof_job_kind_check",sql`(kind = ('document_render'))`),
check("proof_job_state_check",sql`(state IN (('ready'), ('claimed'), ('retry_wait'), ('reconcile'), ('succeeded'), ('failed'), ('cancelled'), ('superseded')))`),
unique().on(t.kind,t.subject,t.producer_key)]);
export const proof_mail = pgTable("proof_mail", {
  id: uuid("id").notNull().primaryKey().default(sql`(gen_random_uuid () )`),
  provider_id: text("provider_id").notNull().unique(),
  rank: integer("rank").notNull().default(sql`(0)`),
});
export const proof_provider_event = pgTable("proof_provider_event", {
  id: text("id").notNull().primaryKey(),
});
export const proof_job_receipt = pgTable("proof_job_receipt", {
  job_id: uuid("job_id").notNull().primaryKey().references(()=>proof_job.id),
});

export { auth_user, auth_session, auth_account, auth_verification } from "@everyfield/db/tables";
