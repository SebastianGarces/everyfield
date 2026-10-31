import { fail, type Config, type TaskRef } from "./lib.ts";

/**
 * The model and effort of each seat role. ROLES holds the defaults. evf.config.json may override them (OPS-69):
 *
 *   "seats": { "<role>": { "model": "claude-...", "effort": "low|medium|high|xhigh|max" } }
 *   "seatTrial": { "roles": ["implementer", "ui"], "model": "claude-opus-5-5", "effort": "medium" }
 *
 * The trial applies to every second task, chosen by the number in the task id, so all seats of one task use the same
 * arm in every round. A config that names an unknown role, a Fable model, a non-claude model, an unknown effort or a
 * non-Opus verifier is refused when evf loads it.
 */
export const ROLES = {
	planner: { model: "claude-opus-5-5", effort: "medium", stage: "plan" },
	implementer: { model: "claude-sonnet-5-5", effort: "medium", stage: "implement" },
	ui: { model: "claude-sonnet-5-5", effort: "medium", stage: "implement" },
	simplifier: { model: "claude-sonnet-5-5", effort: "medium", stage: "simplify" },
	verifier: { model: "claude-opus-5-5", effort: "medium", stage: "verify" },
	ideator: { model: "claude-sonnet-5-5", effort: "medium", stage: "idea" },
	comparer: { model: "claude-sonnet-5-5", effort: "medium", stage: "compare" },
	"prototype-merger": { model: "claude-opus-5-5", effort: "medium", stage: "merge" },
} as const;
export type Role = keyof typeof ROLES;

/** The levels `claude --effort` accepts. */
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type SeatSetting = { model?: string; effort?: string };
export type SeatTrial = { roles: string[]; model?: string; effort?: string };
type SeatConfig = Pick<Config, "seats" | "seatTrial">;

export const isRole = (v: string | undefined): v is Role => !!v && Object.hasOwn(ROLES, v);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True for an Opus model, the only kind that verifies (D82). */
export const isOpus = (model: string | null | undefined): boolean => !!model && model.startsWith("claude-opus-");

/** Why a model is refused, as the tail of an error sentence, or null. Config and `evf task seats` share this. */
function modelProblem(model: string, role: string | null): string | null {
	if (/fable/i.test(model)) return `names a Fable model (${model}); evf never launches one.`;
	if (!model.startsWith("claude-")) return `must start with claude- (got ${model}).`;
	if (role === "verifier" && !isOpus(model)) return "must be an Opus model: only Opus verifies (D82).";
	return null;
}

/** Why an effort is refused, as the tail of an error sentence, or null. */
function effortProblem(effort: unknown): string | null {
	return (EFFORTS as readonly unknown[]).includes(effort)
		? null
		: `must be one of ${EFFORTS.join(", ")} (got ${JSON.stringify(effort)}).`;
}

function checkSetting(field: string, s: unknown, role: string | null): void {
	if (!obj(s)) fail(`evf.config.json ${field} must be an object with model and effort.`);
	const { model, effort } = s;
	if (model !== undefined) {
		if (typeof model !== "string") fail(`evf.config.json ${field}.model must be a string.`);
		const problem = modelProblem(model, role);
		if (problem) fail(`evf.config.json ${field}.model ${problem}`);
	}
	if (effort !== undefined) {
		const problem = effortProblem(effort);
		if (problem) fail(`evf.config.json ${field}.effort ${problem}`);
	}
}

/** Refuse a bad per-task override (`evf task seats`) with the rules the config check applies. */
export function validateOverride(o: SeatSetting): void {
	if (o.model !== undefined) {
		const problem = modelProblem(o.model, null);
		if (problem) fail(`--model ${problem}`);
	}
	if (o.effort !== undefined) {
		const problem = effortProblem(o.effort);
		if (problem) fail(`--effort ${problem}`);
	}
}

/** Refuse a bad `seats` or `seatTrial` before anything launches. */
export function validateSeats(cfg: SeatConfig): void {
	if (cfg.seats !== undefined) {
		if (!obj(cfg.seats)) fail("evf.config.json seats must be an object keyed by role.");
		for (const [role, setting] of Object.entries(cfg.seats)) {
			if (!isRole(role)) fail(`evf.config.json seats.${role} is not a role. Roles: ${Object.keys(ROLES).join(", ")}.`);
			checkSetting(`seats.${role}`, setting, role);
		}
	}
	const trial = cfg.seatTrial;
	if (trial === undefined) return;
	if (!obj(trial)) fail("evf.config.json seatTrial must be an object with roles, model and effort.");
	const roles = trial.roles;
	if (!Array.isArray(roles) || !roles.length || roles.some((r) => typeof r !== "string"))
		fail("evf.config.json seatTrial.roles must be a non-empty list of roles.");
	for (const role of roles as string[])
		if (!isRole(role))
			fail(
				`evf.config.json seatTrial.roles names ${role}, which is not a role. Roles: ${Object.keys(ROLES).join(", ")}.`,
			);
	checkSetting("seatTrial", trial, (roles as string[]).includes("verifier") ? "verifier" : null);
}

/** The number in a task id: OPS-69 → 69, WP-020/ui → 20, FB-12 → 12. */
const taskNumber = (task: TaskRef): number => Number(/\d+/.exec(task.id)?.[0] ?? 0);

/** True for the tasks that run the trial arm: every second task by its number. */
const inTrialArm = (task: TaskRef): boolean => taskNumber(task) % 2 === 1;

/**
 * The model and effort a seat of `role` runs for `task`. A field takes the task override first (OPS-81), then the
 * trial arm, the config override and the default. A non-Opus override model never reaches the verifier (D82): the
 * verifier then ignores the whole override.
 */
export function resolveSeat(
	cfg: SeatConfig,
	task: TaskRef,
	role: Role,
	override: SeatSetting = {},
): { model: string; effort: string; stage: string } {
	const base = ROLES[role];
	const set: SeatSetting = cfg.seats?.[role] ?? {};
	const trial = cfg.seatTrial && cfg.seatTrial.roles.includes(role) && inTrialArm(task) ? cfg.seatTrial : {};
	const own: SeatSetting = role === "verifier" && override.model && !isOpus(override.model) ? {} : override;
	return {
		model: own.model ?? trial.model ?? set.model ?? base.model,
		effort: own.effort ?? trial.effort ?? set.effort ?? base.effort,
		stage: base.stage,
	};
}
