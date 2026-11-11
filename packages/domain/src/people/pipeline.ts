import type * as c from "@everyfield/contracts/people";
import { sql, type SQL } from "@everyfield/db/query";
import type { z } from "zod";
import { assignedTo } from "../tasks/assignees.ts";

// The pipeline's shared rules: which stages share the "Core group" column, and which tasks a person still owes. Every
// read and write takes them from here, so the board, the column locks and the handoff cannot drift apart.

type Stage = z.infer<typeof c.stage>;
type Column = z.infer<typeof c.pipelineColumn>;

/** The committed stages: one "Core group" column on the board (REQ-PPL-007), and a handoff when a person leaves it. */
export const COMMITTED_STAGES = ["core_group", "launch_team", "leader"] as const satisfies readonly Stage[];

export const isCommitted = (stage: string | null | undefined): boolean =>
	stage != null && (COMMITTED_STAGES as readonly string[]).includes(stage);

/** The stages a pipeline column shows. */
export const columnStages = (column: Column): Stage[] => (column === "core_group" ? [...COMMITTED_STAGES] : [column]);

/** The committed stages as one bound text[] parameter, for a SQL comparison with `= ANY(...)`. */
export const committedStagesSql = (): SQL => sql`${sql.param([...COMMITTED_STAGES])}::text[]`;

/**
 * The open duties of a person, over the task row `t`: the person is its subject or their linked account is assigned,
 * it is not deleted, and it is neither complete nor no longer needed. The handoff lock and the stage dialog's duty
 * list both read through it.
 */
export const openDutiesOf = (personId: string, linkedAccountId: string | null): SQL =>
	sql`(t.person_id=${personId}::uuid OR ${assignedTo("t", sql`${linkedAccountId}::uuid`)}) AND t.deleted_at IS NULL AND t.status NOT IN ('complete','no_longer_needed')`;
