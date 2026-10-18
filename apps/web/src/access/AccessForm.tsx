"use client";

import { ArrowDown01Icon, ArrowLeft02Icon, ArrowRight02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
	useActionState,
	useEffect,
	useId,
	useRef,
	useState,
	useTransition,
	type FormEvent,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import { buttonClass } from "@/components/ButtonLink";
import { cn } from "@/components/cn";
import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { revealProps, useReveal } from "@/components/motion/Reveal";
import { stepAccessForm, submitAccessRequest } from "./actions";
import { HONEYPOT, validateAccessRequest, type FieldErrorCode } from "./contract";
import {
	FIELD_NAMES,
	LAST_STEP,
	START,
	STEP_COUNT,
	WHO,
	WHO_FIELD,
	afterReply,
	back,
	kindOf,
	next,
	requestFields,
	withErrors,
	type FormState,
	type Notice,
	type Who,
} from "./steps";

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
/** One step after the choice: its heading and one or two fields. */
export type StepSpec = { title: string; fields: FieldSpec[] };
export type Outcome = { title: string; body: string; link?: string };
export type FormText = {
	/** "Step {step} of {total}". */
	progress: string;
	back: string;
	continue: string;
	submit: string;
	submitting: string;
	who: { title: string; error: string; options: Record<Who, string> };
	optionalLabel: string;
	privacyNote: { text: string; link: string };
	contactEmail: string;
	outcomes: Record<"received" | "invalid" | Notice, Outcome>;
};
/** paths: the three steps after the choice, per answer. A church and a network differ in labels only. */
type Props = { paths: Record<Who, StepSpec[]>; text: FormText };

const ARROW = <Icon icon={ArrowRight02Icon} size={17} />;
const BACK = <Icon icon={ArrowLeft02Icon} size={17} />;
const CHECK = <Icon icon={Tick02Icon} size={18} />;
const CHEVRON = <Icon icon={ArrowDown01Icon} size={18} />;

/* The card and its parts. Error red is magenta-600 (6.4:1 on white); the failure message text is darker still. */
const CARD =
	"relative mx-auto w-full max-w-[600px] rounded-card border border-mk-ink-06 bg-white p-[clamp(24px,4vw,40px)] shadow-mk-card";
const EYEBROW = "text-[13px] leading-[1.3] font-semibold tracking-[0.09em] text-text-2 uppercase";
const CONTROL =
	"w-full rounded-[12px] border border-mk-line-strong bg-mk-canvas px-3.5 py-3 text-[15.5px] text-ink placeholder:text-text-3 placeholder:opacity-100 " +
	"focus:outline-2 focus:outline-offset-1 focus:outline-green-600 disabled:opacity-60 aria-[invalid=true]:border-magenta-600 aria-[invalid=true]:shadow-[inset_0_0_0_1px_var(--color-magenta-600)]";
const ERROR =
	"flex items-baseline gap-1.5 text-[14px] leading-[1.4] font-medium text-magenta-600 before:inline-grid before:size-4 before:flex-none before:translate-y-0.5 before:place-items-center before:rounded-full before:bg-magenta-600 before:text-[11px] before:font-bold before:text-white before:content-['!']";
const MSG =
	"rounded-[12px] text-[14.5px] focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&_p+p]:mt-1";
const FAIL = "px-4 py-3.5 bg-magenta-100 text-mk-danger-ink [&_a]:font-semibold [&_a]:text-inherit [&_a]:underline";
const LINK = "text-green-600 underline";
/* React adds hidden inputs at the start of a form with a server action, so the grid is a wrapper, not the form. */
const LAYOUT = "grid grid-rows-[auto_1fr_auto] gap-6";
/* Every view sits in the same grid cell. Hidden views keep their size, so the card is as tall as the tallest view
   and never changes height. Only the shown view fades in. */
const VIEW = "col-start-1 row-start-1 min-w-0";
const shown = (on: boolean) =>
	on ? "transition-opacity duration-150 ease-out motion-reduce:transition-none" : "invisible opacity-0";
const FIELDSET = "m-0 min-w-0 border-0 p-0";

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

/** An error line. With no error it holds its longest message invisibly, so showing an error never moves anything. */
function ErrorLine({ id, message, reserve }: { id: string; message?: string; reserve: string }) {
	return message ? (
		<p className={ERROR} id={id}>
			{message}
		</p>
	) : (
		<p className={cn(ERROR, "invisible")} aria-hidden="true">
			{reserve}
		</p>
	);
}

type FieldProps = {
	f: FieldSpec;
	id: string;
	err?: FieldErrorCode;
	value?: string;
	sending: boolean;
	optionalLabel: string;
	onCheck: (name: string, onBlur: boolean) => void;
};

function Field({ f, id, err, value, sending, optionalLabel, onCheck }: FieldProps) {
	const describedBy = [f.help ? `${id}-help` : "", err ? `${id}-err` : ""].filter(Boolean).join(" ") || undefined;
	const common = {
		id,
		name: f.name,
		required: !f.optional,
		"aria-invalid": err ? true : undefined,
		"aria-describedby": describedBy,
		autoComplete: f.autoComplete,
		defaultValue: value,
		onBlur: () => onCheck(f.name, true),
		onChange: () => onCheck(f.name, false),
	} as const;
	return (
		<div className="flex flex-col gap-1.5">
			<label htmlFor={id} className="text-[14px] font-semibold">
				{f.label}
				{f.optional ? (
					<>
						{" "}
						<small className="text-[smaller] font-normal text-text-3">{optionalLabel}</small>
					</>
				) : null}
			</label>
			{f.type === "select" ? (
				// appearance-none: WebKit's native select ignores padding and renders shorter than the text fields.
				<div className="relative">
					<select
						{...common}
						className={cn(CONTROL, "appearance-none pe-10")}
						defaultValue={value ?? (f.prompt ? "" : f.options?.[0])}
					>
						{f.prompt ? (
							<option value="" disabled>
								{f.prompt}
							</option>
						) : null}
						{f.options?.map((o) => (
							<option key={o}>{o}</option>
						))}
					</select>
					<span className="pointer-events-none absolute inset-y-0 end-3.5 grid place-items-center text-text-2">
						{CHEVRON}
					</span>
				</div>
			) : f.type === "area" ? (
				<textarea
					{...common}
					rows={3}
					className={cn(CONTROL, "h-[6.5rem] resize-none")}
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
				<p className="text-[13.5px] leading-[1.45] text-text-3" id={`${id}-help`}>
					{f.help}
				</p>
			) : null}
			<ErrorLine
				id={`${id}-err`}
				message={err ? (err === "too_long" ? f.tooLong : f.error) : undefined}
				reserve={f.tooLong.length > f.error.length ? f.tooLong : f.error}
			/>
		</div>
	);
}

type Focus = "step" | "error" | "message";

/**
 * The early access form: "who are you", then three steps of one or two fields, then the outcome. Every step, error
 * and outcome renders inside one card of fixed size, so nothing below the card moves.
 * With JavaScript the browser moves between steps, checks only the current step's fields, and sends the request with
 * submitAccessRequest. Without JavaScript each button posts the form to stepAccessForm, which makes the same moves.
 * The server stays the authority: an "invalid" answer goes back to the first step with an error.
 * A failed send keeps every answer in the form.
 */
export function AccessForm({ paths, text }: Props) {
	const uid = useId();
	const formRef = useRef<HTMLFormElement>(null);
	const cardRef = useRef<HTMLElement>(null);
	const msgRef = useRef<HTMLDivElement>(null);
	const primaryRef = useRef<HTMLButtonElement>(null);
	useReveal(cardRef);
	const rv = revealProps();
	const [serverState, formAction] = useActionState(stepAccessForm, START);
	const [s, setS] = useState<FormState>(serverState);
	const [sending, setSending] = useState(false);
	const [said, setSaid] = useState("");
	const focusNext = useRef<Focus | null>(null);
	const [, startTransition] = useTransition();

	const kind = s.who ? kindOf(s.who) : undefined;
	const notice = s.status !== "editing" && s.status !== "received" ? s.status : undefined;
	const received = s.status === "received";
	const progress = (step: number) =>
		text.progress.replace("{step}", String(step + 1)).replace("{total}", String(STEP_COUNT));
	const network = paths[s.who === "church" ? "church" : "network"];
	const titleOf = (st: FormState) =>
		st.step === 0 || !st.who ? text.who.title : (paths[st.who][st.step - 1]?.title ?? "");

	const read = (): Record<string, string> => {
		const out: Record<string, string> = {};
		for (const [k, v] of new FormData(formRef.current!)) if (typeof v === "string") out[k] = v;
		return out;
	};
	const answers = (all: Record<string, string>) =>
		Object.fromEntries(FIELD_NAMES.flatMap((n) => (all[n] === undefined ? [] : [[n, all[n]]])));

	/** Shows a new state, then moves focus to what changed and says the new step. */
	const land = (n: FormState) => {
		setS(n);
		if (n.status !== "editing") {
			focusNext.current = "message";
			setSaid("");
		} else if (Object.keys(n.errors).length) {
			focusNext.current = "error";
			setSaid(n.invalid ? text.outcomes.invalid.title : "");
		} else {
			focusNext.current = "step";
			setSaid(`${progress(n.step)}. ${titleOf(n)}`);
		}
	};
	useEffect(() => {
		const to = focusNext.current;
		if (!to) return;
		focusNext.current = null;
		if (to === "message") return msgRef.current?.focus();
		const view = formRef.current?.querySelector<HTMLElement>("[data-view=current]");
		const target =
			to === "error"
				? // A radio cannot be marked invalid, so the choice's error focuses the first choice.
					(view?.querySelector<HTMLElement>("[aria-invalid=true]") ?? view?.querySelector<HTMLElement>("input"))
				: (view?.querySelector<HTMLElement>("input:checked") ??
					view?.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea"));
		target?.focus();
	});

	// Once a field shows an error, the error follows what the person types. On leaving a filled field, check it.
	const recheck = (name: string, onBlur: boolean) => {
		if (s.status !== "editing" || !s.who || (!onBlur && !s.errors[name])) return;
		const values = read();
		const v = validateAccessRequest(kindOf(s.who), values);
		const code = v.ok ? undefined : v.fieldErrors[name];
		const errors = { ...s.errors };
		if (code && (s.errors[name] || values[name])) errors[name] = code;
		else delete errors[name];
		setS({ ...s, errors });
	};

	function onSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		if (sending) return;
		const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
		const all = read();
		const values = answers(all);
		if (submitter?.value === "back") return land(back(s, values));
		if (s.step < LAST_STEP || !s.who) return land(next(s, values));
		const who = s.who;
		const v = validateAccessRequest(kindOf(who), values);
		if (!v.ok) return land(withErrors(s, values, v.fieldErrors));
		setSending(true);
		startTransition(async () => {
			let n: FormState;
			try {
				const fields = { ...requestFields(who, values), [HONEYPOT]: all[HONEYPOT] ?? "" };
				n = afterReply(s, values, await submitAccessRequest(kindOf(who), fields));
			} catch {
				// The request did not reach the server, or the reply was lost.
				n = { ...s, values, errors: {}, status: navigator.onLine ? "unavailable" : "offline" };
			}
			setSending(false);
			land(n);
		});
	}
	// Enter on a choice continues, as it does in a text field.
	const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
		if (e.key !== "Enter" || !(e.target instanceof HTMLInputElement) || e.target.type !== "radio") return;
		e.preventDefault();
		formRef.current?.requestSubmit(primaryRef.current);
	};

	const editing = (step: number, path?: "planter" | "network") =>
		s.status === "editing" && s.step === step && (!path || kind === path);
	const fieldsView = (step: StepSpec, n: number, path?: "planter" | "network") => {
		const on = editing(n, path);
		return (
			<fieldset
				key={`${path ?? "contact"}-${n}`}
				className={cn(VIEW, FIELDSET, shown(on))}
				data-view={on ? "current" : undefined}
				// The other request kind's fields are disabled, so they are never sent.
				disabled={path ? kind !== path : !kind}
				inert={!on}
			>
				<legend className="mb-5 p-0">
					<Display as="h2" size="h3">
						{step.title}
					</Display>
				</legend>
				<div className="flex flex-col gap-4">
					{step.fields.map((f) => (
						<Field
							key={f.name}
							f={f}
							id={`${uid}-${f.name}`}
							err={s.errors[f.name]}
							value={s.values[f.name]}
							sending={sending}
							optionalLabel={text.optionalLabel}
							onCheck={recheck}
						/>
					))}
				</div>
			</fieldset>
		);
	};

	const whoErr = s.errors[WHO_FIELD];
	const whoOn = editing(0);
	const outcome = notice ? text.outcomes[notice] : null;
	const done = text.outcomes.received;
	const segment = (i: number) => (i <= s.step ? "bg-ink" : "bg-mk-line-strong");

	return (
		<form
			className={cn(rv.className, CARD)}
			style={rv.style}
			ref={(el) => {
				formRef.current = el;
				cardRef.current = el;
			}}
			action={formAction}
			onSubmit={onSubmit}
			onKeyDown={onKeyDown}
			noValidate
			aria-busy={sending}
			aria-label={text.submit}
		>
			<div className={LAYOUT}>
				<div className={cn("col-start-1 row-start-1 flex items-center justify-between gap-4", received && "invisible")}>
					<p className={EYEBROW}>{progress(s.step)}</p>
					<div className="flex gap-1.5" aria-hidden="true">
						{Array.from({ length: STEP_COUNT }, (_, i) => (
							<span
								key={i}
								className={cn(
									"h-1.5 w-6 rounded-full transition-colors duration-150 motion-reduce:transition-none",
									segment(i),
								)}
							/>
						))}
					</div>
				</div>

				<div className={cn("col-start-1 row-start-2 grid", received && "invisible")}>
					<fieldset
						className={cn(VIEW, FIELDSET, shown(whoOn))}
						data-view={whoOn ? "current" : undefined}
						aria-describedby={whoErr ? `${uid}-who-err` : undefined}
						inert={!whoOn}
					>
						<legend className="mb-5 p-0">
							<Display as="h2" size="h3">
								{text.who.title}
							</Display>
						</legend>
						<div className="flex flex-col gap-3">
							{WHO.map((w) => (
								<label
									key={w}
									className={cn(
										"flex min-h-14 cursor-pointer items-center gap-3 rounded-[12px] border border-mk-line-strong bg-mk-canvas px-4 text-[15.5px] font-semibold text-ink",
										"[transition:border-color_.15s,background-color_.15s,box-shadow_.15s] hover:border-ink/40 motion-reduce:transition-none",
										"has-checked:border-ink has-checked:bg-white has-checked:shadow-[inset_0_0_0_1px_var(--color-ink)]",
										"has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-green-600",
										whoErr && "border-magenta-600",
									)}
								>
									<input
										type="radio"
										name="who"
										value={w}
										checked={s.who === w}
										onChange={() => {
											setS({ ...s, who: w, errors: {} });
										}}
										className="size-[18px] flex-none accent-ink focus-visible:outline-none"
										aria-describedby={whoErr ? `${uid}-who-err` : undefined}
									/>
									{text.who.options[w]}
								</label>
							))}
							<ErrorLine id={`${uid}-who-err`} message={whoErr ? text.who.error : undefined} reserve={text.who.error} />
						</div>
					</fieldset>

					{/* Contact details are the same for every path. */}
					{fieldsView(paths.planter[0]!, 1)}
					{paths.planter.slice(1).map((st, i) => fieldsView(st, i + 2, "planter"))}
					{network.slice(1).map((st, i) => fieldsView(st, i + 2, "network"))}

					<div
						className={cn(VIEW, "self-start", shown(!!outcome), outcome && cn(MSG, FAIL))}
						role="alert"
						tabIndex={outcome ? -1 : undefined}
						ref={outcome ? msgRef : undefined}
					>
						{outcome ? (
							<>
								<p className="font-semibold">{outcome.title}</p>
								<p>{outcome.link ? outcome.body : withMailto(outcome.body)}</p>
								{outcome.link ? (
									<p>
										<a href={"mailto:" + text.contactEmail}>{outcome.link}</a>
									</p>
								) : null}
							</>
						) : null}
					</div>
				</div>

				<div className={cn("col-start-1 row-start-3 flex flex-col gap-4", received && "invisible")} inert={received}>
					{/* The primary button comes first in the markup, so Enter in a field continues. It shows on the right, or on
					    top on small screens, where both buttons are full width on every step so the footer keeps its height. */}
					<div className="flex flex-row-reverse items-center justify-between gap-3 max-mk-sm:flex-col max-mk-sm:items-stretch">
						<button
							ref={primaryRef}
							className={buttonClass(
								"primary",
								"md",
								"justify-center aria-disabled:cursor-progress aria-disabled:bg-ink-2",
							)}
							type="submit"
							name="intent"
							value={s.step < LAST_STEP ? "next" : "send"}
							aria-disabled={sending || undefined}
						>
							{s.step < LAST_STEP ? text.continue : sending ? text.submitting : text.submit}
							{sending ? (
								<span
									className="size-4 animate-spin rounded-full border-2 border-current border-r-transparent [animation-duration:.7s] motion-reduce:animate-none motion-reduce:border-r-current motion-reduce:opacity-60"
									aria-hidden="true"
								/>
							) : (
								ARROW
							)}
						</button>
						<button
							className={cn(
								buttonClass(
									"secondary",
									"md",
									"justify-center ps-5 aria-disabled:cursor-progress aria-disabled:opacity-60",
								),
								s.step === 0 && "invisible",
							)}
							type="submit"
							name="intent"
							value="back"
							aria-disabled={sending || undefined}
							tabIndex={s.step === 0 ? -1 : undefined}
						>
							{BACK}
							{text.back}
						</button>
					</div>
					<p className="text-[13.5px] leading-[1.45] text-text-3">
						{withLink(text.privacyNote.text, text.privacyNote.link, "/privacy")}
					</p>
				</div>

				<div
					className={cn(
						"col-start-1 row-span-full row-start-1 self-center",
						shown(received),
						received && cn(MSG, "flex flex-col items-start gap-4 p-1"),
					)}
					role="status"
					tabIndex={received ? -1 : undefined}
					ref={received ? msgRef : undefined}
				>
					{received ? (
						<>
							<span className="grid size-10 place-items-center rounded-full bg-green-500 text-mk-accent-ink">
								{CHECK}
							</span>
							<Display as="h2" size="h3" className="text-green-700">
								{done.title}
							</Display>
							<p className="max-w-[46ch] text-[15.5px] text-text-2">{done.body}</p>
						</>
					) : null}
				</div>
			</div>

			<div className="absolute size-px overflow-hidden whitespace-nowrap [clip-path:inset(50%)]" aria-hidden="true">
				<label htmlFor={`${uid}-${HONEYPOT}`}>Leave this field empty</label>
				<input id={`${uid}-${HONEYPOT}`} name={HONEYPOT} type="text" tabIndex={-1} autoComplete="off" />
			</div>
			{/* Read only by the no-JavaScript action; the browser keeps this state itself. */}
			<input type="hidden" name="step" value={s.step} />
			{notice ? <input type="hidden" name="notice" value={notice} /> : null}
			<p className="sr-only" role="status">
				{said}
			</p>
		</form>
	);
}
