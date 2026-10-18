import { renderAc, renderBrief } from "./brief.ts";
import { doctor, gc } from "./doctor.ts";
import { EvfError, git, homeRoot, loadConfig, parseTask, readJson, run } from "./lib.ts";
import { recordFastTrack } from './progress.ts';
import { join } from 'node:path';
import { buildBlocks, renderBlocks, selectPackages } from "./plan.ts";
import { principles } from "./principles.ts";
import { feedbackIdeas, feedbackLabels, feedbackPromote, feedbackPull, feedbackStatus, feedbackTriage, feedbackQueue } from "./feedback.ts";
import { listShipped, prOpen, ship, checkPr } from "./ship.ts";
import { approve } from "./approve.ts";
import { debugCmd, stack, taskStart } from "./task.ts";
import { verify } from "./verify.ts";

const HELP = `evf: EveryField v3 workflow CLI

Planning (coordinator)
  evf plan <S0..S5 | WP-NNN ...> [--include-done] [--json]   @@@task blocks for Intent
  evf task brief <task> [--ui-tier UI-1..4] [--full]          context for one task
  evf ac <acceptance-or-case-id> ...                                      full obligations for one criterion
  evf shipped [--clear <task> ...]                            review and acknowledge shipped milestones
  evf shipped --fast-track WP-097 --evidence <file>           record owner-approved completion on main

Task loop (implementor, ui-designer)
  evf task start <task> [--ui-tier UI-n] [--no-stack] [--over-limit]
  evf stack up|down|status <task>
  evf traces <task> [args...]        evf logs <task> [args...]
  evf verify <task> [--quick]                                 local checks
  evf pr open <task> --body-file <file>                       push and open/update the PR
  evf pr check <PR> [--head <sha>]                            read-only Phase 7 merge checks

Verification (verifier)
  evf verify <task> --role verifier [--quick]
  evf ship <task>                           report status and squash-merge

Feedback desk (public feedback repo)
  evf feedback queue [--json]                                 intake, due backlog and recovery
  evf feedback pull [--json]                                  untriaged issues filed by the app bot
  evf feedback triage <n> --class <p0..p3|feature-small|feature-large|duplicate|question|spam>
        --reason "private reason" [--area <module>] [--feature <ID>] [--wp WP-NNN] [--duplicate-of <n>] [--reply "..."]
  evf feedback status [--json]   evf feedback ideas   evf feedback promote <n>   evf feedback labels

Human approval (only after Sebastian approves that PR in chat)
  evf approve <PR> --owner-approval "<his words>" [--head <sha>]
                          Wiki articles, prototypes, feedback P2/P3: record his approval and squash-merge

Upkeep
  evf test [Node test options]                               local tooling regressions on evf's Node
  evf doctor [--here]  evf gc [--apply]
  evf principles [--apply] [--ref <sha>]                      compare or sync principles with pstack

<task> is WP-NNN for a single-part package, WP-NNN/contract, WP-NNN/api, WP-NNN/ui,
FB-<n> for public feedback issue n, or OPS-<n> for reviewed tooling maintenance.`;

function flag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}

function main(argv: string[]): number {
  const args = [...argv];
  const cmd = args.shift();
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return 0;
  }
  const root = homeRoot();
  switch (cmd) {
    case 'test':
      return run(process.execPath,['--test',...args,join(git(process.cwd(),'rev-parse','--show-toplevel'),'tools/evf/tests/reconciliation.test.ts')],{cwd:process.cwd(),inherit:true}).code;
    case "doctor": {
      const here = flag(args, "--here");
      return doctor(here ? git(process.cwd(), "rev-parse", "--show-toplevel") : root);
    }
    case "feedback": {
      const sub = args.shift();
      const issue = () => {
        const n = Number(args.shift());
        if (!Number.isInteger(n) || n <= 0) throw new EvfError("Give the public issue number.");
        return n;
      };
      if (sub === "queue") { console.log(JSON.stringify(feedbackQueue(root))); return 0; }
      if (sub === "pull") return feedbackPull(root, { json: flag(args, "--json") });
      if (sub === "status") return feedbackStatus(root, flag(args, "--json"));
      if (sub === "labels") return feedbackLabels(root);
      if (sub === "ideas") return feedbackIdeas(root);
      if (sub === "promote") return feedbackPromote(root, issue());
      if (sub === "triage") {
        const n = issue();
        return feedbackTriage(root, n, {
          cls: option(args, "--class"),
          reason: option(args, "--reason"),
          area: option(args, "--area"),
          feature: option(args, "--feature"),
          wp: option(args, "--wp"),
          duplicateOf: option(args, "--duplicate-of"),
          reply: option(args, "--reply"),
        });
      }
      break;
    }
    case "approve": {
      const n = Number(args[0]);
      if (!Number.isInteger(n) || n <= 0) throw new EvfError('Give the PR number: evf approve <PR> --owner-approval "<his words>"');
      return approve(root, n, { ownerApproval: option(args, "--owner-approval"), head: option(args, "--head") });
    }
    case "principles":
      return principles(root, { apply: flag(args, "--apply"), ref: option(args, "--ref") });
    case "gc":
      return gc(root, flag(args, "--apply"));
    case "plan": {
      const includeDone = flag(args, "--include-done");
      const json = flag(args, "--json");
      const { pkgs, skipped } = selectPackages(root, args, includeDone);
      const { blocks, external } = buildBlocks(root, pkgs);
      console.log(json ? JSON.stringify({ blocks, external, skipped }, null, 2) : renderBlocks(blocks, external, skipped));
      return 0;
    }
    case "ac":
      console.log((args.length?args:[" "]).map(id=>renderAc(root,id)).join("\n\n"));
      return 0;
    case "shipped": {
      const fastTrack=option(args,'--fast-track');
      if(fastTrack){
        const evidence=option(args,'--evidence');
        if(!evidence||args.length)throw new EvfError('Use evf shipped --fast-track WP-097 --evidence <file>.');
        const cfg=loadConfig(root);
        const fetch=run('git',['fetch',cfg.remote,cfg.baseBranch],{cwd:root});
        if(fetch.code!==0)throw new EvfError('Cannot confirm current main before fast-track completion.');
        recordFastTrack(root,fastTrack,readJson<unknown>(evidence));
        console.log('WP-097 fast-track completion recorded. Commit the evf-generated progress through reviewed maintenance.');return 0;
      }
      const clear: string[] = [];
      for (let v = option(args, "--clear"); v; v = option(args, "--clear")) clear.push(v);
      return listShipped(root, clear);
    }
    case "task": {
      const sub = args.shift();
      const uiTier = option(args, "--ui-tier");
      if (sub === "brief") {
        const full = flag(args, "--full");
        console.log(renderBrief(root, parseTask(args[0]), { uiTier, full }));
        return 0;
      }
      if (sub === "start") {
        const allowUnready = flag(args, "--allow-unready");
        const noStack = flag(args, "--no-stack");
        const overLimit = flag(args, "--over-limit");
        return taskStart(root, parseTask(args[0]), { allowUnready, noStack, uiTier, overLimit });
      }
      break;
    }
    case "stack": {
      const action = args.shift();
      if (action === "up" || action === "down" || action === "status") return stack(root, parseTask(args[0]), action);
      break;
    }
    case "traces":
    case "logs":
      return debugCmd(root, parseTask(args.shift()), cmd, args);
    case "verify": {
      const role = option(args, "--role") ?? "author";
      if (role !== "author" && role !== "verifier") break;
      const quick = flag(args, "--quick");
      return verify(root, parseTask(args[0]), role, quick ? "quick" : "full").passed ? 0 : 1;
    }
    case "pr": {
      const sub=args.shift();
      if(sub==='open'){const bodyFile=option(args,'--body-file');return prOpen(root,parseTask(args[0]),bodyFile);}
      if(sub==='check') {
        const head=option(args,'--head'),number=Number(args[0]);
        if(!Number.isInteger(number)||number<=0)throw new EvfError('Give the PR number.');
        console.log(JSON.stringify(checkPr(root,number,head),null,2));return 0;
      }
      break;
    }
    case "ship": {
      return ship(root, parseTask(args[0]));
    }
  }
  console.error(`Unknown command: evf ${argv.join(" ")}\n\n${HELP}`);
  return 2;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof EvfError) {
    console.error(`evf: ${e.message}`);
    process.exitCode = 1;
  } else throw e;
}
