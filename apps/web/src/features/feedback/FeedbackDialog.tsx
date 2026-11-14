"use client";

import {
	ArrowDown01Icon,
	Bug01Icon,
	Comment01Icon,
	HelpCircleIcon,
	Idea01Icon,
	InformationCircleIcon,
	SentIcon,
} from "@hugeicons/core-free-icons";
import type { FeedbackCategory, SubmittedFeedback } from "@everyfield/contracts/feedback";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Textarea,
} from "@everyfield/ui/controls";
import { cn, EvryBot, Icon, type IconSvgElement } from "@everyfield/ui/foundations";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useId, useState, useTransition, type ReactNode } from "react";
import { loadSendContext, sendFeedback, type DialogContext } from "./actions.ts";
import { CATEGORIES, counter, PROMPT, readPageDetails, timeLabel, type PageDetails } from "./model.ts";

const ICON: Record<FeedbackCategory, IconSvgElement> = {
	bug: Bug01Icon,
	suggestion: Idea01Icon,
	question: HelpCircleIcon,
	other: Comment01Icon,
};

type Sent = SubmittedFeedback;
type Failure = "lost" | "refused" | null;

/**
 * Send feedback (the drawn Feedback dialog, REQ-ADM-001): a type, the words and the page and device details, with no
 * screenshot or file. It opens over the current page and reads that page's details when it opens. Church, role, app
 * version and time are the server's; the list shows what the server will store. A lost reply keeps the same request key,
 * so sending again saves the feedback once.
 */
export function FeedbackDialog({
	open,
	onOpenChange,
	name,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	name: string;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open ? <FeedbackPanel name={name} onClose={() => onOpenChange(false)} /> : null}
		</Dialog>
	);
}

function FeedbackPanel({ name, onClose }: { name: string; onClose: () => void }) {
	const [details] = useState<PageDetails>(readPageDetails);
	const [context, setContext] = useState<DialogContext | null>(null);
	const [category, setCategory] = useState<FeedbackCategory>("suggestion");
	const [text, setText] = useState("");
	const [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
	const [sent, setSent] = useState<Sent | null>(null);
	const [failure, setFailure] = useState<Failure>(null);
	const [pending, start] = useTransition();
	const count = counter(text);
	const ids = { count: useId(), types: useId() };

	useEffect(() => {
		let live = true;
		void loadSendContext().then((r) => live && r.status === "ok" && setContext(r.value));
		return () => {
			live = false;
		};
	}, []);

	function edit(change: () => void) {
		change();
		// Changed words are new feedback: a new key, so it is not mistaken for a resend of the last attempt.
		if (failure === "lost") setRequestKey(crypto.randomUUID());
		setFailure(null);
	}

	function send() {
		if (count.problem || pending) return;
		setFailure(null);
		start(async () => {
			const r = await sendFeedback({
				requestKey,
				category,
				description: text,
				page: details.page,
				address: details.address,
				browser: details.browser,
				screenWidth: details.screenWidth,
				screenHeight: details.screenHeight,
				theme: details.theme,
			});
			if (r.status === "ok") setSent(r.value);
			else setFailure(r.status === "lost" ? "lost" : "refused");
		});
	}

	function again() {
		setSent(null);
		setText("");
		setRequestKey(crypto.randomUUID());
	}

	const page = details.page ?? "this page";
	const first = name.split(/\s+/)[0] || name;

	if (sent)
		return (
			<DialogContent style={{ maxWidth: 620 }} aria-describedby={undefined}>
				<div className="flex flex-col items-center gap-2.5 px-[30px] pt-[34px] pb-[30px] text-center">
					<EvryBot size="xl" mood="happy" />
					<DialogTitleText>Thank you, {first}</DialogTitleText>
					<p className="m-0 max-w-[380px] text-md text-text-2">
						Your feedback is saved, together with the details from <b className="font-semibold text-ink">{page}</b>. If
						we have a question, we reply to {sent.replyTo}.
					</p>
					<div className="mt-3 flex gap-2">
						<Button variant="secondary" onClick={again}>
							Send more
						</Button>
						<Button variant="primary" onClick={onClose}>
							Done
						</Button>
					</div>
				</div>
			</DialogContent>
		);

	const rows: [string, string | null][] = [
		["Page", details.page],
		["Address", details.address],
		["Church", context ? context.church : null],
		["Your role", context ? context.role : null],
		["Browser", details.browser],
		["Screen", details.screenWidth && details.screenHeight ? `${details.screenWidth} × ${details.screenHeight}` : null],
		["Theme", details.theme === "dark" ? "Dark" : details.theme === "light" ? "Light" : null],
		["App version", context?.appVersion ?? null],
		["Time", timeLabel(details.openedAt)],
	];

	return (
		<DialogContent style={{ maxWidth: 620 }}>
			<DialogHeader
				title="Send feedback"
				description="Tell us what went wrong or what would help. The Everyfield team reads every message."
			/>
			<DialogBody className="flex flex-col gap-4 pb-1">
				<div role="radiogroup" aria-label="Type" id={ids.types} className="grid grid-cols-4 gap-2">
					{CATEGORIES.map((c) => (
						<label
							key={c.value}
							className={cn(
								"flex cursor-pointer flex-col items-start gap-2 rounded-card px-3 pt-3 pb-[11px] text-sm font-medium transition-[background-color,box-shadow] duration-150 has-[:focus-visible]:shadow-[0_0_0_1.5px_var(--ef-ink),0_0_0_4px_color-mix(in_srgb,var(--ef-focus)_28%,transparent)]",
								category === c.value
									? "bg-surface-raised text-ink shadow-[inset_0_0_0_1.5px_var(--ef-ink),var(--ef-shadow-raised)]"
									: "bg-surface-2 text-ink-2 hover:bg-surface-raised hover:shadow-[inset_0_0_0_1px_var(--ef-line-2)]",
							)}
						>
							<input
								type="radio"
								name="feedback-type"
								value={c.value}
								checked={category === c.value}
								onChange={() => edit(() => setCategory(c.value))}
								className="sr-only"
							/>
							<Icon icon={ICON[c.value]} size={18} className={category === c.value ? "text-ink" : "text-text-2"} />
							{c.label}
						</label>
					))}
				</div>
				<div className="flex flex-col gap-1.5">
					<label htmlFor={`${ids.count}-text`} className="text-sm font-medium text-ink-2">
						{PROMPT[category]}
					</label>
					<Textarea
						id={`${ids.count}-text`}
						value={text}
						onChange={(e) => edit(() => setText(e.target.value))}
						placeholder="Describe it in your own words."
						className="min-h-[130px]"
						aria-describedby={`${ids.count}-hint ${ids.count}-count`}
						invalid={count.problem !== null && text.length > 0}
						autoFocus
					/>
					<div className="flex items-start justify-between gap-3 text-xs">
						<span id={`${ids.count}-hint`} className="text-text-3">
							Please do not include passwords or private details about people.
						</span>
						<span
							id={`${ids.count}-count`}
							aria-live="polite"
							className={cn(
								"flex-none tabular-nums",
								count.problem && text ? "font-medium text-magenta-600" : "text-text-3",
							)}
						>
							{count.problem && text ? `${count.problem} · ${count.text}` : count.text}
						</span>
					</div>
				</div>
				<details className="group rounded-card bg-surface-2 px-4 py-1">
					<summary className="flex cursor-pointer list-none items-center gap-2.5 py-3 text-sm font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
						<Icon icon={InformationCircleIcon} size={18} />
						<span>
							Sent with your feedback: <b className="font-semibold">{page}</b> and 8 more details
						</span>
						<Icon
							icon={ArrowDown01Icon}
							size={16}
							className="ml-auto text-text-3 transition-transform duration-200 group-open:rotate-180"
						/>
					</summary>
					<dl className="mt-0 mb-3.5 grid grid-cols-[130px_minmax(0,1fr)] gap-x-3.5 gap-y-[7px] text-sm">
						{rows.map(([k, v]) => (
							<div key={k} className="contents">
								<dt className="text-text-2">{k}</dt>
								<dd className={cn("m-0 [overflow-wrap:anywhere]", v ? "text-ink" : "text-text-3")}>
									{k === "Address" && v ? <code className="text-[12.5px]">{v}</code> : (v ?? "Unknown")}
								</dd>
							</div>
						))}
					</dl>
				</details>
				{failure ? (
					<p role="alert" className="m-0 text-sm font-medium text-magenta-600">
						{failure === "lost"
							? "We could not confirm it was sent. Send again: it is saved only once."
							: "Your feedback could not be sent from this account."}
					</p>
				) : null}
			</DialogBody>
			<DialogFooter>
				<span className="grow text-sm text-text-3">No screenshot is sent.</span>
				<Button variant="ghost" onClick={onClose}>
					Cancel
				</Button>
				<Button variant="primary" icon={SentIcon} onClick={send} disabled={count.problem !== null} loading={pending}>
					Send
				</Button>
			</DialogFooter>
		</DialogContent>
	);
}

function DialogTitleText({ children }: { children: ReactNode }) {
	return (
		<DialogPrimitive.Title className="mt-2 font-title text-title-md leading-[1.2] tracking-[-0.02em] text-balance text-ink">
			{children}
		</DialogPrimitive.Title>
	);
}
