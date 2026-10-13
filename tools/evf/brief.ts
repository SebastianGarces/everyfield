import {
  acceptanceFor,
  findPackage,
  loadConfig,
  loadDag,
  loadProgress,
  loadRegistry,
  loadRulings,
  oneLine,
  partsOf,
  pathsForPart,
  worktreePath,
  type AcceptanceEntry,
  type TaskRef,
} from "./lib.ts";
import { renderFeedbackBrief } from "./feedback.ts";

const UI_EFFORT: Record<string, string> = { "UI-1": "low", "UI-2": "medium", "UI-3": "high", "UI-4": "high" };

export function renderBrief(root: string, task: TaskRef, opts: { uiTier?: string; full?: boolean }): string {
  if (task.kind === "fb") return renderFeedbackBrief(root, task);
  const cfg = loadConfig(root);
  const dag = loadDag(root);
  const pkg = findPackage(dag, task.wp);
  const progress = loadProgress(root);
  const registry = acceptanceFor(loadRegistry(root), pkg.id);
  const rulings = loadRulings(root).filter((r) => r.work_packages?.includes(pkg.id));
  const paths = pathsForPart(pkg, task.part);
  const others = pkg.owning_paths.filter((p) => !paths.includes(p));
  const L: string[] = [];

  L.push(`# Task brief: ${task.id}: ${pkg.title}${task.part ? ` (${task.part})` : ""}`);
  L.push("");
  L.push(`Lane ${pkg.lane}, domain ${pkg.domain}, estimate ${pkg.estimate_engineer_days} engineer-days for the whole package.`);
  L.push(`Worktree: \`${worktreePath(root, cfg, task)}\` on branch \`${task.branch}\`.`);
  if (partsOf(pkg).length > 1) L.push(`This package ships as: ${partsOf(pkg).map((p) => `${pkg.id}/${p}`).join(", ")}.`);
  L.push("");

  L.push("## Prerequisites (canonical status)");
  if (!pkg.depends_on.length) L.push("- None.");
  for (const d of pkg.depends_on) L.push(`- ${d}: ${progress[d]?.status ?? "unknown"}: ${findPackage(dag, d).title}`);
  if (task.part === "api" || task.part === "ui") {
    const anchor = partsOf(pkg).includes("contract") ? `${pkg.id}/contract` : task.part === "ui" ? `${pkg.id}/api` : null;
    if (anchor) L.push(`- ${anchor} must be merged first. Build against its contract in \`packages/contracts/\`.`);
  }
  L.push("");

  L.push("## Paths");
  L.push(`- You own: ${paths.map((p) => `\`${p}\``).join(", ")}`);
  if (others.length) L.push(`- Same package, other task, do not edit: ${others.map((p) => `\`${p}\``).join(", ")}`);
  L.push("- Shared changes outside these paths need the coordinator's approval. Record it in the PR body.");
  L.push("");

  L.push("## Outputs and interfaces");
  for (const o of pkg.outputs) L.push(`- ${o}`);
  L.push("");

  L.push("## Package acceptance gates (dag.json)");
  for (const g of pkg.acceptance_gates) L.push(`- ${g}`);
  L.push("");

  L.push(`## Acceptance criteria (${registry.length} in docs/evidence/acceptance-registry.json)`);
  if (!registry.length) L.push("- None registered. Use the package gates above as the acceptance list.");
  for (const e of registry) L.push(...acLines(e, opts.full === true));
  if (registry.length && !opts.full) L.push("", "Full obligations for one criterion: `evf ac <id>`. All of them: `evf task brief " + task.id + " --full`.");
  L.push("");

  const specs = [...new Set(registry.map((e) => e.spec).filter(Boolean))];
  L.push("## Read before you build");
  L.push(`- \`docs/plan/build-plan.md\`, section "### ${pkg.id}".`);
  for (const s of specs) L.push(`- \`${s}\`, only the sections for the feature IDs above.`);
  L.push("- `docs/architecture/architecture.md` for operation contracts, transactions and tenancy rules.");
  L.push("");

  L.push("## Product rulings that apply");
  if (!rulings.length) L.push("- None recorded for this package. Rule small ambiguities yourself and record them (skill `decisions`).");
  for (const r of rulings) L.push(`- ${r.id} (${r.decision_id}, ${r.status}): ${r.title}. ${oneLine(r.ruling, 400)}`);
  L.push("");

  if (task.part === "ui") {
    L.push("## UI");
    if (opts.uiTier) L.push(`- Tier ${opts.uiTier}, reasoning effort \`${UI_EFFORT[opts.uiTier] ?? "high"}\`.`);
    else L.push("- Tier: not set. The coordinator sets UI-1..UI-4.");
    L.push("- Use the `better-interface` skill suite. New components come from the shadcn CLI.");
    if (opts.uiTier === "UI-4") L.push("- UI-4: build 2 or 3 live prototypes and ask Sebastian to pick before you finish.");
    L.push("");
  }

  L.push("## Integration rule");
  L.push(`- ${pkg.integration_rule}`);
  L.push("");
  L.push("## Commands");
  L.push(`- Verify: \`evf verify ${task.id}\` (author) or \`evf verify ${task.id} --role verifier\`.`);
  L.push(`- Open the PR: \`evf pr open ${task.id}\`. Merge (verifier only): \`evf ship ${task.id}\`.`);
  L.push(`- Debug: \`evf stack status ${task.id}\`, \`evf traces ${task.id} <request-id>\`, \`evf logs ${task.id}\`.`);
  return L.join("\n");
}

function acLines(e: AcceptanceEntry, full: boolean): string[] {
  const head = `- **${e.id}** (${e.feature_id}): ${full ? e.positive_obligation : oneLine(e.positive_obligation)}`;
  if (!full) return [head];
  const out = [head];
  const add = (label: string, xs?: string[]) => {
    if (xs?.length) out.push(`  - ${label}: ${xs.join(" | ")}`);
  };
  add("Operations", e.operations);
  add("Validation", e.validation_obligations);
  add("Permission denial", e.permission_denial_obligations);
  add("State and history", e.state_history_obligations);
  add("Failure and recovery", e.failure_recovery_obligations);
  add("Test layers", e.required_test_layers);
  return out;
}

export function renderAc(root: string, id: string): string {
  const hits = loadRegistry(root).filter((e) => e.id === id || e.shared_gate_id === id);
  if (!hits.length) return `No acceptance criterion with ID ${id}.`;
  return hits.flatMap((e) => [...acLines(e, true), `  - Spec: ${e.spec}. Packages: ${e.work_packages.join(", ")}.`]).join("\n");
}
