import type * as c from "@everyfield/contracts/people";
import { sql, type SQL } from "@everyfield/db/query";
import type { z } from "zod";
import { assignedTo } from "../tasks/assignees.ts";

type Stage = z.infer<typeof c.stage>;
type Column = z.infer<typeof c.pipelineColumn>;

const COMMITTED_STAGES = ["core_group", "launch_team", "leader"] as const satisfies readonly Stage[];

export const isCommitted = (stage: string | null | undefined): boolean =>
	stage != null && (COMMITTED_STAGES as readonly string[]).includes(stage);

export const columnStages = (column: Column): Stage[] => (column === "core_group" ? [...COMMITTED_STAGES] : [column]);

export const committedStagesSql = (): SQL => sql`${sql.param([...COMMITTED_STAGES])}::text[]`;

export const openDutiesOf = (personId: string | SQL, linkedAccountId: string | SQL | null): SQL =>
	sql`(t.person_id=${personId}::uuid OR ${assignedTo("t", sql`${linkedAccountId}::uuid`)}) AND t.deleted_at IS NULL AND t.status NOT IN ('complete','no_longer_needed')`;
