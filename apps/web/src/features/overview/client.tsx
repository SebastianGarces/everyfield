"use client";

import {
	SETUP_STEPS,
	type OverviewFrame,
	type PromptKey,
	type QuickAction,
	type SetupStep,
} from "@everyfield/contracts/dashboard";
import { CalendarAdd01Icon, FileImportIcon, Tick02Icon, UserAdd01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	buttonVariants,
	Card,
	CardActions,
	CardClose,
	CardDescription,
	CardHeader,
	CardHeading,
	CardTitle,
	IntentLink,
	useToast,
} from "@everyfield/ui/controls";
import { cn, Icon } from "@everyfield/ui/foundations";
import { useState } from "react";
import { SaveNotice, useSaveIntent } from "../../components/save/parts.tsx";
import { problemText } from "../meetings/model.ts";
import { PlanMeetingDialog } from "../meetings/PlanMeetingDialog.tsx";
import { AddPersonDialog } from "../people/AddPersonDialog.tsx";
import { dismissPrompt } from "./actions.ts";
import { PROMPT_TEXT, QUICK_ACTION_LABEL, STEP_TEXT } from "./model.ts";

const PROMPT_OF: Partial<Record<SetupStep, PromptKey>> = { add_people: "import_people", invite_team: "invite_team" };

/**
 * The first week's checklist, or the optional prompts after it (ADM-005). A step is done from what the church recorded;
 * dismissing a prompt only hides it, here at once and on the server for every later visit. Members see the steps
 * without the actions they cannot use.
 */
export function GetStarted({ frame }: { frame: OverviewFrame }) {
	const toast = useToast();
	const [hidden, setHidden] = useState<ReadonlySet<PromptKey>>(new Set());
	const admin = frame.role !== "member";
	const prompts = frame.prompts.filter((p) => !hidden.has(p));
	const open = (s: SetupStep) => frame.setup.gaps.includes(s);
	// A step whose prompt this person dismissed earlier stays off the checklist.
	const dismissed = (s: SetupStep) => {
		const p = PROMPT_OF[s];
		return admin && p !== undefined && open(s) && !prompts.includes(p);
	};

	async function dismiss(prompt: PromptKey) {
		setHidden((h) => new Set(h).add(prompt));
		const result = await dismissPrompt(prompt).catch(() => ({ status: "failed" as const }));
		if (result.status === "ok") return;
		setHidden((h) => {
			const next = new Set(h);
			next.delete(prompt);
			return next;
		});
		toast({ message: "That prompt could not be dismissed. Try again in a moment.", tone: "error" });
	}

	const steps = frame.firstWeek ? SETUP_STEPS.filter((s) => !dismissed(s)) : SETUP_STEPS.filter((s) => {
		const p = PROMPT_OF[s];
		return p !== undefined && prompts.includes(p);
	});
	if (!steps.length) return null;
	const done = SETUP_STEPS.filter((s) => !open(s)).length;
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>{frame.firstWeek ? "Your first week" : "Next steps"}</CardTitle>
					<CardDescription>
						{frame.firstWeek
							? `${done} of ${SETUP_STEPS.length} done. These get your people, your meetings and your team into one place.`
							: "Optional. Dismiss one you don't need."}
					</CardDescription>
				</CardHeading>
			</CardHeader>
			<ol className="flex flex-col">
				{steps.map((s, i) => {
					const text = STEP_TEXT[s];
					const prompt = PROMPT_OF[s];
					const isDone = !open(s);
					return (
						<li
							key={s}
							className="flex items-center gap-4 border-t border-line py-4 first:border-t-0 max-app-sm:flex-wrap"
						>
							<span
								aria-hidden="true"
								className={cn(
									"grid size-8 flex-none place-items-center rounded-pill text-sm font-semibold",
									isDone ? "bg-green-100 text-green-700" : "bg-surface-2 text-text-2",
								)}
							>
								{isDone ? <Icon icon={Tick02Icon} size={16} /> : i + 1}
							</span>
							<div className="min-w-0 flex-1">
								<p className={cn("text-[15px] font-medium", isDone ? "text-text-3 line-through" : "text-ink")}>
									{!frame.firstWeek && prompt ? PROMPT_TEXT[prompt].title : text.title}
									{isDone ? <span className="sr-only"> (done)</span> : null}
								</p>
								{isDone ? null : <p className="mt-0.5 text-md text-text-3">{text.detail}</p>}
							</div>
							{!isDone && admin ? (
								<CardActions className="max-app-sm:ml-12">
									<IntentLink href={text.action.href} className={buttonVariants({ variant: "secondary", size: "sm" })}>
										{text.action.label}
									</IntentLink>
									{prompt && prompts.includes(prompt) ? (
										<CardClose label={`Dismiss "${PROMPT_TEXT[prompt].title}"`} onClick={() => void dismiss(prompt)} />
									) : null}
								</CardActions>
							) : null}
						</li>
					);
				})}
			</ol>
		</Card>
	);
}

/** The quick actions the seat can use now; each opens the working flow. A Member has none, so none show. */
export function QuickActions({ actions }: { actions: readonly QuickAction[] }) {
	const [adding, setAdding] = useState(false);
	const [planning, setPlanning] = useState(false);
	const lane = useSaveIntent({ explain: problemText });
	if (!actions.length) return null;
	return (
		<Card>
			<CardHeader>
				<CardHeading>
					<CardTitle>Quick actions</CardTitle>
				</CardHeading>
			</CardHeader>
			<SaveNotice {...lane.noticeProps} dialogOpen={planning} />
			<div className="flex flex-wrap gap-2.5">
				{actions.includes("add_person") ? (
					<Button variant="secondary" icon={UserAdd01Icon} onClick={() => setAdding(true)}>
						{QUICK_ACTION_LABEL.add_person}
					</Button>
				) : null}
				{actions.includes("import_people") ? (
					<IntentLink href="/people/import" className={buttonVariants({ variant: "secondary" })}>
						<Icon icon={FileImportIcon} size={18} />
						{QUICK_ACTION_LABEL.import_people}
					</IntentLink>
				) : null}
				{actions.includes("plan_meeting") ? (
					<Button variant="secondary" icon={CalendarAdd01Icon} onClick={() => setPlanning(true)}>
						{QUICK_ACTION_LABEL.plan_meeting}
					</Button>
				) : null}
			</div>
			{actions.includes("add_person") ? <AddPersonDialog open={adding} onOpenChange={setAdding} /> : null}
			{actions.includes("plan_meeting") ? (
				<PlanMeetingDialog open={planning} onOpenChange={setPlanning} lane={lane} />
			) : null}
		</Card>
	);
}
