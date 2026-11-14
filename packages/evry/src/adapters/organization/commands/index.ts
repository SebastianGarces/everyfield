import { sql } from "@everyfield/db/query";
import { profileFields } from "@everyfield/contracts/organizations";
import { z } from "zod";
import { committed, nativeWrite, organizationAdmin, patchChanges } from "../../native.ts";

// A sending church's or network's own profile, for its Owner or Admin, through the same native command the Settings >
// Organization profile section runs. This is the only tool an organization login has today.

const COLUMN = {
	name: "name",
	city: "city",
	stateProvince: "state_province",
	country: "country",
	description: "description",
	contactEmail: "contact_email",
	contactPhone: "contact_phone",
	statementOfFaith: "statement_of_faith",
} as const;

export const updateProfile = nativeWrite({
	operation: "organizations.updateProfile",
	description:
		"Propose a change to this organization's profile: its name, city, state or province, country, description, contact email or phone, or a network's statement of faith. Nothing changes until the user approves the exact review.",
	input: z.strictObject({
		patch: profileFields.partial().refine((p) => Object.keys(p).length > 0, "empty patch"),
	}),
	allowed: organizationAdmin,
	review(actor, value) {
		return sql`SELECT jsonb_build_object('target',jsonb_build_object('kind','organization','id',o.id,'label',o.name),
				'changes',${patchChanges(value.patch, COLUMN, sql`o`)}) AS review,
			jsonb_build_object('expectedRevision',o.revision::text,'input',jsonb_build_object(
				'organization',jsonb_build_object('kind','organization','id',o.id,'organizationKind',o.kind),
				'patch',${JSON.stringify(value.patch)}::jsonb)) AS args
			FROM organization o WHERE o.id=${actor.owner.id}::uuid`;
	},
	async run(tx, context, request, { ports }) {
		committed(
			await ports.organizations["organizations.updateProfile"](tx, context.session, context.selected, request as never),
		);
	},
});

/** The installed organization reviewed writes, keyed by operation. */
export const ORGANIZATION_COMMANDS = { "organizations.updateProfile": updateProfile } as const;
