import "server-only";
import type { PoolClient } from "pg";
import type { z } from "zod";
import { type Owner, type sessionId, type Subject } from "@everyfield/contracts/common";
import { sharedOperationCheckRequest } from "@everyfield/contracts/access";
import { accessPolicies, type OperationPolicy } from "./policy.ts";

// Bind a closed, purpose-specific mapping in server code, never a request/model
// field. Producers select columns explicitly; raw row spreads are not a DTO.
export function readProjection<T>(
	access: ReturnType<typeof accessPolicies>,
	projection: {
		operation: OperationPolicy["operation"];
		purpose: "native" | "model" | "export" | "organization_aggregate";
		schema: z.ZodType<T>;
		load(tx: PoolClient, subject: Subject): Promise<unknown>;
	},
) {
	return async function projectRead(
		tx: PoolClient,
		session: z.infer<typeof sessionId>,
		selected: Owner,
		raw: unknown,
	): Promise<T | null> {
		const input = sharedOperationCheckRequest.safeParse(raw);
		if (
			!input.success ||
			input.data.kind !== "read" ||
			input.data.operation !== projection.operation ||
			input.data.purpose !== projection.purpose ||
			["private_week", "private_week_revision", "person_note"].includes(input.data.subject.kind)
		)
			return null;
		const check = await access.checkOperation(tx, session, selected, input.data);
		if (check.status !== "allowed") return null;
		return projection.schema.parse(await projection.load(tx, input.data.subject));
	};
}
