import { z } from "zod";
import { generateDrizzleJson } from "drizzle-kit/api";

const strings = z.array(z.string());
const key = z.object({ name: z.string(), columns: strings }).passthrough();
const column = z
	.object({
		name: z.string(),
		type: z.string(),
		primaryKey: z.boolean(),
		notNull: z.boolean(),
		default: z.unknown().optional(),
	})
	.passthrough();
const foreign = z
	.object({
		name: z.string(),
		tableFrom: z.string(),
		tableTo: z.string(),
		schemaTo: z.string().optional(),
		columnsFrom: strings,
		columnsTo: strings,
		onDelete: z.string().optional(),
		onUpdate: z.string().optional(),
	})
	.passthrough();
const index = z
	.object({
		name: z.string(),
		isUnique: z.boolean(),
		where: z.string().optional(),
		columns: z.array(z.object({ expression: z.string(), isExpression: z.boolean() }).passthrough()),
	})
	.passthrough();
const table = z
	.object({
		name: z.string(),
		schema: z.string(),
		columns: z.record(z.string(), column),
		foreignKeys: z.record(z.string(), foreign),
		compositePrimaryKeys: z.record(z.string(), key),
		uniqueConstraints: z.record(z.string(), key),
		indexes: z.record(z.string(), index),
		checkConstraints: z.record(z.string(), z.object({ name: z.string(), value: z.string() })),
		policies: z.record(z.string(), z.unknown()),
		isRLSEnabled: z.boolean(),
	})
	.passthrough();
/** Kit's stable API is an external boundary; retain its full artifact and validate fields we consume. */
export const snapshotShape = z
	.object({
		version: z.literal("7"),
		dialect: z.literal("postgresql"),
		id: z.string(),
		prevId: z.string(),
		tables: z.record(z.string(), table),
		schemas: z.record(z.string(), z.string()),
	})
	.passthrough();
export const declaredSnapshot = (declarations: Record<string, unknown>) =>
	snapshotShape.parse(generateDrizzleJson(declarations));
export type SchemaSnapshot = z.infer<typeof snapshotShape>;
