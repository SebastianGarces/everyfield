"use client";

import { ArrowRight02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { buttonClass } from "@/components/ButtonLink";
import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { revealProps, useReveal } from "@/components/motion/Reveal";
import { submitAccessRequest } from "./actions";
import {
	HONEYPOT,
	validateAccessRequest,
	type AccessRequestKind,
	type FieldErrorCode,
	type FieldErrors,
} from "./contract";

export type FieldSpec = {
	name: string;
	label: string;
	type: "text" | "email" | "select" | "area" | "number";
	optional?: boolean;
	help?: string;
	/** Message for a missing or wrongly formatted value. */
	error: string;
	/** Message for a value over the limit ({max} already filled in). */
	tooLong: string;
	placeholder?: string;
	/** First, empty option of a select. */
	prompt?: string;
	options?: readonly string[];
	autoComplete?: string;
};
export type Outcome = { title: string; body: string; link?: string };
export type OutcomeKey = "received" | "invalid" | "rate_limited_email" | "rate_limited_ip" | "unavailable" | "offline";
export type FormText = {
	eyebrow: string;
	headline: string;
	body: string;
	submit: string;
	submitting: string;
	optionalLabel: string;
	privacyNote: { text: string; link: string };
	contactEmail: string;
	outcomes: Record<OutcomeKey, Outcome>;
};
/** delay: the card rises in once (ms after it comes into view; the second card follows the first by 70 ms). */
type Props = { kind: AccessRequestKind; id: string; fields: FieldSpec[]; text: FormText; delay?: number };

type Notice = Exclude<OutcomeKey, "received" | "invalid">;
type Phase =
	{ s: "editing"; errors: FieldErrors; tried: boolean; notice?: Notice } | { s: "sending" } | { s: "received" };

const ARROW = <Icon icon={ArrowRight02Icon} size={17} />;
const CHECK = <Icon icon={Tick02Icon} size={16} />;

/* The form card and its parts. Error red is magenta-600 (6.4:1 on white); the failure message text is darker still. */
const CARD =
	"flex flex-col gap-4 rounded-card border border-mk-ink-06 bg-white p-[clamp(22px,3vw,40px)] shadow-mk-card";
const EYEBROW = "inline-block text-[13px] leading-[1.3] font-semibold tracking-[0.09em] text-text-2 uppercase";
const CONTROL =
	"w-full rounded-[12px] border border-mk-line-strong bg-mk-canvas px-3.5 py-3 text-[15.5px] text-ink placeholder:text-text-3 placeholder:opacity-100 " +
	"focus:outline-2 focus:outline-offset-1 focus:outline-green-600 disabled:opacity-60 aria-[invalid=true]:border-magenta-600 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--color-magenta-600)]";
const MSG =
	"rounded-[12px] text-[14.5px] focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&_p+p]:mt-1";
const FAIL = "px-3.5 py-3 bg-magenta-100 text-mk-danger-ink [&_a]:font-semibold [&_a]:text-inherit [&_a]:underline";
const LINK = "text-green-600 underline";

/** Links each e-mail address in a sentence. */
function withMailto(text: string): ReactNode[] {
	return text.split(/([^\s@]+@[^\s@]+\.[a-z]{2,})/i).map((part, i) => {
		if (!(i % 2)) return part;
		const addr = part.replace(/[.,;:]+$/, "");
		return (
			<span key={i}>
				<a href={"mailto:" + addr}>{addr}</a>
				{part.slice(addr.length)}
			</span>
		);
	});
}
/** Links the first occurrence of `words` in `text` to `href`. */
function withLink(text: string, words: string, href: string): ReactNode {
	const i = text.indexOf(words);
	if (i < 0) return text;
	return (
		<>
			{text.slice(0, i)}
			<a href={href} className={LINK}>
				{words}
			</a>
			{text.slice(i + words.length)}
		</>
	);
}

/**
 * One early access form (planter or network). Markup follows the prototype's form card. It adds labels tied to
 * inputs, help text, field errors, a hidden honeypot, a sending state and the outcome messages from the copy.
 * The same contract validates here (instant feedback) and in the server action (authority).
 * A failed send keeps every answer in the form.
 */
export function AccessForm({ kind, id, fields, text, delay = 0 }: Props) {
	const uid = useId();
	const formRef = useRef<HTMLFormElement>(null);
	const msgRef = useRef<HTMLDivElement>(null);
	const cardRef = useRef<HTMLElement>(null);
	useReveal(cardRef);
	const rv = revealProps(delay);
	// True while the pointer is down on the submit button. A blur check then would show an error, shift the
	// layout and move the button out from under the pointer, so the click would miss. Submit checks every field.
	const pressing = useRef(false);
	const focusAfterReply = useRef(false);
	const [phase, setPhase] = useState<Phase>({ s: "editing", errors: {}, tried: false });
	const [, startTransition] = useTransition();
	const errors = phase.s === "editing" ? phase.errors : {};
	const sending = phase.s === "sending";

	const read = (): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [k, v] of new FormData(formRef.current!)) if (typeof v === "string") out[k] = v;
		return out;
	};
	const focusFirst = (errs: FieldErrors) => {
		const first = fields.find((f) => errs[f.name]);
		if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first.name}"]`)?.focus();
	};
	// After the server answers, move focus to what changed: the first field error, or the message.
	useEffect(() => {
		if (!focusAfterReply.current || phase.s === "sending") return;
		focusAfterReply.current = false;
		if (phase.s === "editing" && !phase.notice) focusFirst(phase.errors);
		else msgRef.current?.focus();
	});
	// After the first submit, or once a field shows an error, errors follow what the person types.
	const recheck = (name: string, onBlur: boolean) => {
		if (phase.s !== "editing" || (onBlur && pressing.current)) return;
		if (!onBlur && !phase.tried && !phase.errors[name]) return;
		const values = read();
		const v = validateAccessRequest(kind, values);
		const code = v.ok ? undefined : v.fieldErrors[name];
		const next = { ...phase.errors };
		// On blur before the first submit, only flag a field the person has filled in.
		if (code && (phase.tried || !onBlur || values[name])) next[name] = code;
		else delete next[name];
		setPhase({ ...phase, errors: next });
	};

	function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		pressing.current = false;
		if (sending) return;
		const values = read();
		const v = validateAccessRequest(kind, values);
		if (!v.ok) {
			setPhase({ s: "editing", errors: v.fieldErrors, tried: true });
			focusFirst(v.fieldErrors);
			return;
		}
		setPhase({ s: "sending" });
		startTransition(async () => {
			let next: Phase;
			try {
				const r = await submitAccessRequest(kind, values);
				if (r.status === "received") next = { s: "received" };
				else if (r.status === "invalid") next = { s: "editing", errors: r.fieldErrors, tried: true };
				else if (r.status === "rate_limited")
					next = {
						s: "editing",
						errors: {},
						tried: true,
						notice: r.reason === "email" ? "rate_limited_email" : "rate_limited_ip",
					};
				else next = { s: "editing", errors: {}, tried: true, notice: "unavailable" };
			} catch {
				// The request did not reach the server, or the reply was lost.
				next = { s: "editing", errors: {}, tried: true, notice: navigator.onLine ? "unavailable" : "offline" };
			}
			focusAfterReply.current = true;
			setPhase(next);
		});
	}

	const head = (
		<>
			<span className={EYEBROW}>{text.eyebrow}</span>
			<Display as="h2" size="h3">
				{text.headline}
			</Display>
		</>
	);

	if (phase.s === "received") {
		const o = text.outcomes.received;
		return (
			<div
				className={cn(rv.className, CARD)}
				style={rv.style}
				id={id}
				ref={(el) => {
					cardRef.current = el;
				}}
			>
				{head}
				<div
					className={cn(MSG, "flex items-start gap-3 bg-green-100 p-4 text-ink")}
					role="status"
					tabIndex={-1}
					ref={msgRef}
				>
					<span className="grid size-7 flex-none place-items-center rounded-full bg-green-500 text-mk-accent-ink">
						{CHECK}
					</span>
					<div>
						<p className="font-semibold text-green-700">{o.title}</p>
						<p>{o.body}</p>
					</div>
				</div>
			</div>
		);
	}

	const notice = phase.s === "editing" && phase.notice ? text.outcomes[phase.notice] : null;
	const invalid = phase.s === "editing" && !phase.notice && Object.keys(errors).length ? text.outcomes.invalid : null;
	const message = (code: FieldErrorCode, f: FieldSpec) => (code === "too_long" ? f.tooLong : f.error);

	return (
		<form
			className={cn(rv.className, CARD)}
			style={rv.style}
			id={id}
			ref={(el) => {
				formRef.current = el;
				cardRef.current = el;
			}}
			onSubmit={onSubmit}
			noValidate
			aria-busy={sending}
			aria-describedby={`${uid}-body`}
		>
			{head}
			<p className="text-[14px] text-text-3" id={`${uid}-body`}>
				{text.body}
			</p>
			{fields.map((f) => {
				const fid = `${uid}-${f.name}`,
					err = errors[f.name];
				const describedBy =
					[f.help ? `${fid}-help` : "", err ? `${fid}-err` : ""].filter(Boolean).join(" ") || undefined;
				const common = {
					id: fid,
					name: f.name,
					required: !f.optional,
					"aria-invalid": err ? true : undefined,
					"aria-describedby": describedBy,
					autoComplete: f.autoComplete,
					onBlur: () => recheck(f.name, true),
					onChange: () => recheck(f.name, false),
				} as const;
				return (
					<div className="flex flex-col gap-1.5" key={f.name}>
						<label htmlFor={fid} className="text-[14px] font-semibold">
							{f.label}
							{f.optional ? (
								<>
									{" "}
									<small className="text-[smaller] font-normal text-text-3">{text.optionalLabel}</small>
								</>
							) : null}
						</label>
						{f.type === "select" ? (
							<select {...common} className={CONTROL} defaultValue={f.prompt ? "" : f.options?.[0]}>
								{f.prompt ? (
									<option value="" disabled>
										{f.prompt}
									</option>
								) : null}
								{f.options?.map((o) => (
									<option key={o}>{o}</option>
								))}
							</select>
						) : f.type === "area" ? (
							<textarea
								{...common}
								className={cn(CONTROL, "min-h-24 resize-y")}
								readOnly={sending}
								placeholder={f.placeholder}
							/>
						) : (
							<input
								{...common}
								className={CONTROL}
								readOnly={sending}
								type={f.type === "number" ? "text" : f.type}
								inputMode={f.type === "number" ? "numeric" : f.type === "email" ? "email" : undefined}
								spellCheck={f.type === "email" ? false : undefined}
								placeholder={f.placeholder}
							/>
						)}
						{f.help ? (
							<p className="text-[13.5px] leading-[1.45] text-text-3" id={`${fid}-help`}>
								{f.help}
							</p>
						) : null}
						{err ? (
							<p
								className="flex items-baseline gap-1.5 text-[14px] leading-[1.4] font-medium text-magenta-600 before:inline-grid before:size-4 before:flex-none before:translate-y-0.5 before:place-items-center before:rounded-full before:bg-magenta-600 before:text-[11px] before:font-bold before:text-white before:content-['!']"
								id={`${fid}-err`}
							>
								{message(err, f)}
							</p>
						) : null}
					</div>
				);
			})}
			<div className="absolute size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]" aria-hidden="true">
				<label htmlFor={`${uid}-${HONEYPOT}`}>Leave this field empty</label>
				<input id={`${uid}-${HONEYPOT}`} name={HONEYPOT} type="text" tabIndex={-1} autoComplete="off" />
			</div>
			{/* The button and privacy note sit at the card bottom, so both cards line up side by side. */}
			<div className="mt-auto flex flex-col gap-4">
				<button
					className={buttonClass("primary", "md", "aria-disabled:cursor-progress aria-disabled:bg-ink-2")}
					type="submit"
					aria-disabled={sending || undefined}
					onPointerDown={() => {
						pressing.current = true;
					}}
					onPointerUp={() =>
						setTimeout(() => {
							pressing.current = false;
						}, 0)
					}
					onPointerCancel={() => {
						pressing.current = false;
					}}
				>
					{sending ? text.submitting : text.submit}
					{sending ? (
						<span
							className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent [animation-duration:.7s] motion-reduce:animate-none motion-reduce:border-r-current motion-reduce:opacity-60"
							aria-hidden="true"
						/>
					) : (
						ARROW
					)}
				</button>
				<p className="text-[13.5px] leading-[1.45] text-text-3">
					{withLink(text.privacyNote.text, text.privacyNote.link, "/privacy")}
				</p>
			</div>
			{notice ? (
				<div className={cn(MSG, FAIL)} role="alert" tabIndex={-1} ref={msgRef}>
					<p className="font-semibold">{notice.title}</p>
					<p>{notice.link ? notice.body : withMailto(notice.body)}</p>
					{notice.link ? (
						<p>
							<a href={"mailto:" + text.contactEmail}>{notice.link}</a>
						</p>
					) : null}
				</div>
			) : (
				<div className={invalid ? cn(MSG, FAIL) : "hidden"} role="status">
					{invalid ? (
						<>
							<p className="font-semibold">{invalid.title}</p>
							<p>{invalid.body}</p>
						</>
					) : null}
				</div>
			)}
		</form>
	);
}
