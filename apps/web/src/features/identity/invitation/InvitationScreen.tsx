"use client";

import {
	CheckmarkCircle02Icon,
	Clock01Icon,
	Mail01Icon,
	MailValidation01Icon,
	UserIcon,
	WifiDisconnected01Icon,
} from "@hugeicons/core-free-icons";
import {
	acceptSeatInvitationRequest,
	invitationDescriptionResult,
	nativePassword,
	normalizedEmail,
	respondResidentInvitationRequest,
	residentInvitationDecisionResult,
	seatInvitationAcceptedResult,
} from "@everyfield/contracts/identity";
import { Button, ConfirmDialog, Field, Input, Skeleton } from "@everyfield/ui/controls";
import { Avatar } from "@everyfield/ui/display";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type FormEvent,
	type ReactNode,
} from "react";
import { NotAvailable } from "../../access/AccessStates";
import { Refusal, useIntent, useLoad } from "../../organizations/intent";
import { ProblemLine } from "../../organizations/parts";
import { ResidencyDisclosure } from "../../organizations/Residency";
import { identityApi, loadPage } from "../api";
import { AuthFooter, AuthHeading } from "../AuthFrame";
import { refusalMessage } from "../messages";
import { FormMessage, Outcome, PasswordInput } from "../parts";
import { AFTER_SIGN_IN, SignInForm } from "../SignInScreen";
import { acceptSeatInvitation, readInvitation, respondResidentInvitation } from "./client";
import {
	formatExpiry,
	joinTitle,
	ROLE_TEXT,
	tabStore,
	type Description,
	type Held,
	type ResidentCommand,
	type SeatCommand,
} from "./model";

// /invitation, the link in a seat or residency invitation email (REQ-IDN-017, REQ-MUL-004). The page reads the proof,
// removes it from the address bar and keeps it in this tab. It shows who invited whom to what (REQ-IDN-003), then
// lets the invited person create an account or sign in, and accept or decline. Every proof the domain will not
// honour (unknown, expired, withdrawn, replaced or used) shows the same NotAvailable state.

const PAGE = "/invitation";

type Session = Awaited<ReturnType<typeof readInvitation>>["session"];
type Read = { description: ReturnType<typeof invitationDescriptionResult.parse>; session: Session };

const noSubscription = () => () => {};

export function InvitationScreen() {
	// The fragment never reaches the server; after sign-in the page opens without it, and this tab kept it.
	const proof = useSyncExternalStore(noSubscription, tabStore.proof, () => undefined);
	useLayoutEffect(() => tabStore.keepProof(), []);
	if (proof === undefined) return <Loading />;
	if (!proof) return <Unavailable />;
	return <InvitationFor proof={proof} />;
}

function InvitationFor({ proof }: { proof: string }) {
	const fetch = useCallback(async (): Promise<Read> => {
		const r = await readInvitation(proof);
		return { description: invitationDescriptionResult.parse(r.description), session: r.session };
	}, [proof]);
	const { state, reload, refreshing } = useLoad(fetch, "The invitation did not load");
	const [held, setHeld] = useState<Held | null>(() => tabStore.held(proof));

	if (state.status === "loading") return <Loading />;
	if (state.status === "error")
		return (
			<div role="alert">
				<Outcome
					icon={WifiDisconnected01Icon}
					tone="magenta"
					title="The invitation did not load"
					actions={
						<Button variant="primary" onClick={reload} className="w-full">
							Try again
						</Button>
					}
				>
					Unable to reach Everyfield. Check your connection and try again.
				</Outcome>
			</div>
		);
	if (state.status !== "ready") return <Loading />;
	const { description, session } = state.data;
	// An answer was sent from this tab and never confirmed. Resend that exact command before anything else.
	if (held)
		return (
			<Unconfirmed
				held={held}
				onSettled={() => {
					tabStore.release();
					setHeld(null);
					reload();
				}}
			/>
		);
	if (description.status === "unavailable") return <Unavailable />;
	if (session === "unavailable")
		return (
			<Outcome
				icon={WifiDisconnected01Icon}
				tone="magenta"
				title="Sign-in is unavailable"
				actions={
					<Button variant="primary" onClick={reload} className="w-full">
						Try again
					</Button>
				}
			>
				Everyfield could not check your sign-in. Try again in a few minutes.
			</Outcome>
		);
	if (session === "signed_out") return <SignedOut description={description} proof={proof} />;
	return description.subject.purpose === "seat" ? (
		<SeatAnswer description={description} proof={proof} refreshing={refreshing} onRefused={reload} onHeld={setHeld} />
	) : (
		<ResidentAnswer
			description={description}
			proof={proof}
			refreshing={refreshing}
			onRefused={reload}
			onHeld={setHeld}
		/>
	);
}

function Loading() {
	return (
		<div aria-busy="true">
			<span className="sr-only" role="status">
				Loading the invitation
			</span>
			<Skeleton shape="block" height={72} />
			<Skeleton width="70%" height={38} className="mt-7" />
			<Skeleton width="90%" className="mt-3" />
			<Skeleton shape="block" height={44} className="mt-8" />
		</div>
	);
}

function Unavailable() {
	return (
		<>
			<NotAvailable scope="page" homeHref={AFTER_SIGN_IN} />
			<p className="mt-4 text-center text-sm text-text-2 text-pretty">
				If you expected an invitation, ask the person who sent it for a new link.
			</p>
		</>
	);
}

/** The blue notice from the prototype's sign-in screen: who invited you, to what, and until when. */
function Notice({ description }: { description: Description }) {
	const s = description.subject;
	return (
		<div className="mb-7 flex items-start gap-3 rounded-md bg-blue-50 px-4 py-3.5 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--ef-blue-500)_20%,transparent)]">
			<Avatar name={description.inviterDescription} tone="green" size="sm" decorative />
			<div className="min-w-0 text-sm text-ink-2">
				<p>
					<b className="font-semibold text-ink">{description.inviterDescription}</b> invited you{" "}
					{s.purpose === "seat" ? (
						<>
							to join <b className="font-semibold text-ink">{description.workspaceName}</b> as{" "}
							{ROLE_TEXT[s.role].withArticle}.
						</>
					) : (
						<>
							to link your account to <b className="font-semibold text-ink">{description.workspaceName}</b>. This does
							not give you a seat there.
						</>
					)}
				</p>
				<p className="mt-1 text-text-3">
					Expires <time dateTime={description.expiresAt}>{formatExpiry(description.expiresAt)}</time>
				</p>
			</div>
		</div>
	);
}

type Mode = { mode: "join" } | { mode: "sign_in"; email: string; afterRegister: boolean };
type FieldName = "name" | "email" | "password";

/** Signed out: create the account the invitation names, or sign in to an existing one (REQ-IDN-030). */
function SignedOut({ description, proof }: { description: Description; proof: string }) {
	const [mode, setMode] = useState<Mode>({ mode: "join" });
	const seat = description.subject.purpose === "seat";
	const label = seat ? "join" : "continue";
	if (mode.mode === "sign_in")
		return (
			<>
				<Notice description={description} />
				<AuthHeading title={mode.afterRegister ? "Sign in to continue" : "Welcome back"}>
					{mode.afterRegister
						? `Enter the password for ${mode.email} to finish. If you forgot it, reset it from the link below.`
						: seat
							? "Sign in to accept the invitation."
							: "Sign in to answer the invitation."}
				</AuthHeading>
				<SignInForm returnTo={PAGE} initialEmail={mode.email} submitLabel={`Sign in and ${label}`} />
				<AuthFooter>
					New to Everyfield?{" "}
					<button type="button" className={INLINE} onClick={() => setMode({ mode: "join" })}>
						Create an account
					</button>
				</AuthFooter>
			</>
		);
	return (
		<>
			<Notice description={description} />
			<AuthHeading title={joinTitle(description)}>
				{seat
					? "Create your account to accept. Use the address the invitation was sent to."
					: "Create your account, then choose what to share. Use the address the invitation was sent to."}
			</AuthHeading>
			<JoinForm
				proof={proof}
				submitLabel={`Create account and ${label}`}
				onSignInNeeded={(email) => setMode({ mode: "sign_in", email, afterRegister: true })}
			/>
			<AuthFooter>
				Already use Everyfield?{" "}
				<button
					type="button"
					className={INLINE}
					onClick={() => setMode({ mode: "sign_in", email: "", afterRegister: false })}
				>
					{seat ? "Sign in to accept" : "Sign in to answer"}
				</button>
			</AuthFooter>
		</>
	);
}

const INLINE =
	"cursor-pointer rounded-[4px] font-semibold text-ink underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-60";

function JoinForm({
	proof,
	submitLabel,
	onSignInNeeded,
}: {
	proof: string;
	submitLabel: string;
	onSignInNeeded: (email: string) => void;
}) {
	const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// One key for this form, so a resubmit after a lost response is the same registration.
	const [requestKey] = useState(() => crypto.randomUUID());
	const nameRef = useRef<HTMLInputElement>(null);
	const emailRef = useRef<HTMLInputElement>(null);
	const passwordRef = useRef<HTMLInputElement>(null);

	async function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (busy) return;
		const data = new FormData(event.currentTarget);
		const name = String(data.get("name") ?? "").trim();
		const email = normalizedEmail.safeParse(data.get("email"));
		const password = String(data.get("password") ?? "");
		const next: Partial<Record<FieldName, string>> = {
			name: name ? undefined : "Enter your name.",
			email: email.success ? undefined : "Enter an email address, like name@church.org.",
			password: nativePassword.safeParse(password).success
				? undefined
				: password.length > 1024
					? "Use 1,024 characters or fewer."
					: "Use at least 8 characters.",
		};
		setErrors(next);
		setRefusal(null);
		const first = (["name", "email", "password"] as const).find((f) => next[f]);
		if (first || !email.success) {
			({ name: nameRef, email: emailRef, password: passwordRef })[first ?? "email"].current?.focus();
			return;
		}
		setBusy(true);
		const registered = await identityApi.register({
			kind: "invitation",
			name,
			email: email.data,
			password,
			requestKey,
			invitationProof: proof,
		});
		if (!registered.ok) {
			setBusy(false);
			setRefusal(refusalMessage("register", registered.error));
			return;
		}
		// Registration answers the same whether or not the address already had an account. Signing in with the password
		// just typed is the proof that continues; anything else asks for that account's own password.
		const signedIn = await identityApi.signIn({ email: email.data, password });
		if (signedIn.ok) {
			tabStore.setJoining(email.data);
			loadPage(PAGE);
			return;
		}
		setBusy(false);
		onSignInNeeded(email.data);
	}

	return (
		<form noValidate onSubmit={submit} className="mt-6 flex flex-col gap-4">
			<Field label="Your name" error={errors.name}>
				<Input ref={nameRef} name="name" icon={UserIcon} autoComplete="name" maxLength={200} />
			</Field>
			<Field label="Email" error={errors.email}>
				<Input
					ref={emailRef}
					name="email"
					type="email"
					icon={Mail01Icon}
					autoComplete="email"
					inputMode="email"
					spellCheck={false}
					autoCapitalize="none"
				/>
			</Field>
			<Field label="Create a password" hint="8 to 1,024 characters." error={errors.password}>
				<PasswordInput ref={passwordRef} name="password" autoComplete="new-password" />
			</Field>
			<FormMessage tone="error">{refusal}</FormMessage>
			<Button type="submit" variant="primary" loading={busy} className="w-full">
				{submitLabel}
			</Button>
		</form>
	);
}

/** A refusal of an answer. The domain gives one code for every reason a claim fails, so the words stay general. */
function refusedText(code: string | null): string {
	if (code === "temporary") return "Someone is changing this invitation right now. Try again in a moment.";
	return "This invitation cannot be accepted with this account. Sign in with the account for the invited address, and confirm that address first.";
}

async function sendSeat(command: SeatCommand) {
	const reply = await acceptSeatInvitation(command);
	if (reply.status === "refused") throw new Refusal(reply.code);
	return seatInvitationAcceptedResult.parse(reply.value);
}

async function sendResident(command: ResidentCommand) {
	const reply = await respondResidentInvitation(command);
	if (reply.status === "refused") throw new Refusal(reply.code);
	return residentInvitationDecisionResult.parse(reply.value);
}

/** Keeps the command in this tab while it is unconfirmed, so a reload can resend it unchanged. */
function holding<C, T>(store: (command: C) => void, send: (command: C) => Promise<T>) {
	return async (command: C) => {
		store(command);
		return send(command);
	};
}

function SignOutLine() {
	const [busy, setBusy] = useState(false);
	return (
		<AuthFooter>
			Signed in with a different account?{" "}
			<button
				type="button"
				className={INLINE}
				disabled={busy}
				onClick={async () => {
					setBusy(true);
					await identityApi.signOut();
					loadPage(PAGE);
				}}
			>
				Sign out
			</button>
		</AuthFooter>
	);
}

type AnswerProps = {
	description: Description;
	proof: string;
	/** The description is being read again; a command built from it now could be stale. */
	refreshing: boolean;
	onRefused: () => void;
	onHeld: (held: Held) => void;
};

/** A signed-in account accepts a seat (seats.acceptInvitation). Account creation from this page accepts at once. */
function SeatAnswer({ description, proof, refreshing, onRefused, onHeld }: AnswerProps) {
	const intent = useIntent<SeatCommand>("seat-accept");
	const [done, setDone] = useState<ReturnType<typeof seatInvitationAcceptedResult.parse> | null>(null);
	const [joining] = useState(() => tabStore.joining());
	const started = useRef(false);
	const [attempts, setAttempts] = useState(0);
	// Set once a claim from a just-created account is refused; the confirm step then stays until the seat is ready.
	const [confirming, setConfirming] = useState(false);
	const role = description.subject.purpose === "seat" ? description.subject.role : "member";

	const accept = useCallback(async () => {
		setAttempts((n) => n + 1);
		const result = await intent.run(
			description.invitationId,
			(requestKey) =>
				acceptSeatInvitationRequest.parse({
					requestKey,
					expectedRevision: description.revision,
					input: { invitationId: description.invitationId, proof },
				}),
			holding(
				(command: SeatCommand) =>
					tabStore.hold({ proof, workspaceName: description.workspaceName, kind: "seat", command }),
				async (command: SeatCommand) => {
					try {
						return await sendSeat(command);
					} catch (e) {
						if (e instanceof Refusal && e.code !== "temporary" && joining) setConfirming(true);
						throw e;
					}
				},
			),
			() => true,
		);
		if (result.ok) {
			tabStore.release();
			tabStore.setJoining(null);
			setDone(result.reply);
			return;
		}
		if (result.problem === "refused") {
			tabStore.release();
			onRefused();
		}
		if (result.problem === "unknown") onHeld(tabStore.held(proof)!);
	}, [intent, description, proof, joining, onRefused, onHeld]);

	// The person already chose "Create account and join"; their first signed-in view accepts for them once.
	useEffect(() => {
		if (joining && !started.current) {
			started.current = true;
			void accept();
		}
	}, [joining, accept]);

	if (done)
		return (
			<Outcome
				icon={CheckmarkCircle02Icon}
				tone="green"
				title={`You joined ${description.workspaceName}`}
				actions={
					<Button variant="primary" className="w-full" onClick={() => loadPage(AFTER_SIGN_IN)}>
						Continue
					</Button>
				}
			>
				Your {ROLE_TEXT[done.seat.role].name} seat is ready. {ROLE_TEXT[done.seat.role].detail}
			</Outcome>
		);
	if (joining && confirming)
		return (
			<ConfirmEmail
				email={joining}
				busy={intent.pending !== null || refreshing}
				stillRefused={attempts > 1 && intent.problem === "refused"}
				onContinue={() => void accept()}
			/>
		);

	return (
		<>
			<Notice description={description} />
			<AuthHeading title={joinTitle(description)}>
				Accept to get your {ROLE_TEXT[role].name} seat. {ROLE_TEXT[role].detail}
			</AuthHeading>
			<ProblemLine problem={intent.problem} refused={refusedText(intent.code)} />
			<Button
				variant="primary"
				className="mt-6 w-full"
				loading={intent.pending !== null}
				disabled={refreshing}
				onClick={() => void accept()}
			>
				Accept and join
			</Button>
			<SignOutLine />
		</>
	);
}

/**
 * A new account cannot claim until its address is confirmed. The link goes to the address typed on this page; the
 * answer is the same whether or not that address has an account.
 */
function ConfirmEmail({
	email,
	busy,
	stillRefused,
	onContinue,
}: {
	email: string;
	busy: boolean;
	/** Continue was tried after the link went out and the claim was still refused. */
	stillRefused: boolean;
	onContinue: () => void;
}) {
	const { sent, send } = useConfirmationLink(email, true);
	return (
		<Outcome
			icon={MailValidation01Icon}
			tone="blue"
			title="Confirm your email to join"
			actions={
				<>
					<FormMessage tone="error">
						{sent === "failed"
							? "The link was not sent. Check your connection and send it again."
							: stillRefused && !busy
								? "Your email is not confirmed yet, or this invitation is for another address. Open the newest link, then select Continue."
								: null}
					</FormMessage>
					<FormMessage tone="success">{sent === "sent" ? `We sent a link to ${email}.` : null}</FormMessage>
					<Button variant="primary" className="w-full" loading={busy} onClick={onContinue}>
						Continue
					</Button>
					<Button variant="ghost" className="w-full" loading={sent === "sending"} onClick={() => void send()}>
						Send the link again
					</Button>
				</>
			}
		>
			Open the confirmation link in your email. Then come back to this page and select Continue.
		</Outcome>
	);
}

/** Sends a confirmation link to the address typed on this page, once on open when `auto` is set. */
function useConfirmationLink(email: string, auto: boolean) {
	const [sent, setSent] = useState<"idle" | "sending" | "sent" | "failed">("idle");
	const send = useCallback(async () => {
		setSent("sending");
		const r = await identityApi.sendVerification(email);
		setSent(r.ok ? "sent" : "failed");
	}, [email]);
	const once = useRef(false);
	useEffect(() => {
		if (auto && !once.current) {
			once.current = true;
			void send();
		}
	}, [auto, send]);
	return { sent, send };
}

/** For an account this page just created: its address must be confirmed before it can link. */
function ConfirmHint({ email }: { email: string }) {
	const { sent, send } = useConfirmationLink(email, false);
	return (
		<div className="mt-3 flex flex-col gap-3">
			<FormMessage tone="success">
				{sent === "sent" ? `We sent a link to ${email}. Open it, then select Accept and join again.` : null}
			</FormMessage>
			<FormMessage tone="error">
				{sent === "failed" ? "The link was not sent. Check your connection and try again." : null}
			</FormMessage>
			<Button variant="secondary" loading={sent === "sending"} onClick={() => void send()}>
				Send a confirmation link to {email}
			</Button>
		</div>
	);
}

type ResidentDone = ReturnType<typeof residentInvitationDecisionResult.parse>;

/**
 * A signed-in account answers a residency invitation (residency.respondInvitation, REQ-MUL-004). The WP-007/ui
 * ResidencyDisclosure collects the sharing, unchecked by default, and its chosen value goes into the command exactly
 * as the component hands it over (ruling D51). Accepting never gives a seat; declining leaves the account unchanged.
 */
function ResidentAnswer({ description, proof, refreshing, onRefused, onHeld }: AnswerProps) {
	const intent = useIntent<ResidentCommand>("resident-answer");
	const [done, setDone] = useState<ResidentDone | null>(null);
	const [joining] = useState(() => tabStore.joining());

	const answer = async (
		input:
			| { decision: "accept"; choices: { shareFoundations: boolean; shareMilestones: boolean } }
			| { decision: "decline" },
	) => {
		const result = await intent.run(
			description.invitationId,
			(requestKey) =>
				respondResidentInvitationRequest.parse({
					requestKey,
					expectedRevision: description.revision,
					input: { invitationId: description.invitationId, proof, ...input },
				}),
			holding(
				(command: ResidentCommand) =>
					tabStore.hold({ proof, workspaceName: description.workspaceName, kind: "resident", command }),
				sendResident,
			),
			() => true,
		);
		if (result.ok) {
			tabStore.release();
			tabStore.setJoining(null);
			setDone(result.reply);
			return;
		}
		if (result.problem === "refused") {
			tabStore.release();
			onRefused();
		}
		if (result.problem === "unknown") onHeld(tabStore.held(proof)!);
	};

	if (done) return <ResidentOutcome done={done} organizationName={description.workspaceName} />;
	const locked = refreshing || intent.pending !== null;
	return (
		<>
			<Notice description={description} />
			<p className="sr-only" role="status">
				{refreshing ? "Checking the invitation again" : ""}
			</p>
			{/* While the invitation is read again or an answer is on its way, the choices and buttons wait. */}
			<div inert={locked} aria-busy={locked} className={locked ? "opacity-70" : undefined}>
				<ResidencyDisclosure
					organizationName={description.workspaceName}
					onAccept={(choices) => answer({ decision: "accept", choices })}
				/>
			</div>
			<ProblemLine problem={intent.problem} refused={refusedText(intent.code)} />
			{joining && intent.problem === "refused" && intent.code !== "temporary" ? <ConfirmHint email={joining} /> : null}
			<AuthFooter>
				Not for you?{" "}
				<ConfirmDialog
					title="Decline this invitation?"
					description={`${description.workspaceName} will not be linked to your account. Your account stays as it is.`}
					confirmLabel="Decline invitation"
					onConfirm={() => answer({ decision: "decline" })}
					trigger={
						<button type="button" className={INLINE} disabled={locked}>
							Decline the invitation
						</button>
					}
				/>
			</AuthFooter>
			<SignOutLine />
		</>
	);
}

function ResidentOutcome({ done, organizationName }: { done: ResidentDone; organizationName: string }) {
	if (done.status === "declined")
		return (
			<Outcome
				icon={CheckmarkCircle02Icon}
				tone="green"
				title="You declined the invitation"
				actions={
					<Button variant="primary" className="w-full" onClick={() => loadPage(AFTER_SIGN_IN)}>
						Continue
					</Button>
				}
			>
				Nothing changed in your account. {organizationName} can send a new invitation if you change your mind.
			</Outcome>
		);
	const shared = [
		done.choices.shareFoundations && "foundation progress",
		done.choices.shareMilestones && "milestone progress",
	].filter(Boolean);
	return (
		<Outcome
			icon={CheckmarkCircle02Icon}
			tone="green"
			title={`You joined the residency at ${organizationName}`}
			actions={
				<Button asChild variant="primary" className="w-full">
					<a href="/settings/sharing">Review your sharing</a>
				</Button>
			}
		>
			{shared.length ? `You share your ${shared.join(" and ")}.` : "You share nothing yet."} This link does not give you
			a seat. You can change what you share at any time.
		</Outcome>
	);
}

/**
 * An answer left this tab and no reply came back. Its outcome is unknown, so the page resends that exact command:
 * the server returns the saved result when the first one landed, and makes no second change.
 */
function Unconfirmed({ held, onSettled }: { held: Held; onSettled: () => void }) {
	const intent = useIntent<SeatCommand | ResidentCommand>("held");
	const [done, setDone] = useState<ReactNode>(null);
	const retry = async () => {
		const result =
			held.kind === "seat"
				? await intent.run(
						"held",
						() => held.command,
						sendSeat,
						() => true,
					)
				: await intent.run(
						"held",
						() => held.command,
						sendResident,
						() => true,
					);
		if (result.ok) {
			tabStore.release();
			tabStore.setJoining(null);
			const reply = result.reply;
			setDone(
				"seat" in reply ? (
					<Outcome
						icon={CheckmarkCircle02Icon}
						tone="green"
						title={`You joined ${held.workspaceName}`}
						actions={
							<Button variant="primary" className="w-full" onClick={() => loadPage(AFTER_SIGN_IN)}>
								Continue
							</Button>
						}
					>
						Your {ROLE_TEXT[reply.seat.role].name} seat is ready.
					</Outcome>
				) : (
					<ResidentOutcome done={reply} organizationName={held.workspaceName} />
				),
			);
		} else if (result.problem === "refused") onSettled();
	};
	if (done) return <>{done}</>;
	const answer = held.kind === "seat" ? "accept" : held.command.input.decision;
	return (
		<Outcome
			icon={Clock01Icon}
			tone="amber"
			title="We could not confirm your answer"
			actions={
				<>
					<ProblemLine problem={intent.problem === "unknown" ? "unknown" : null} />
					<Button variant="primary" className="w-full" loading={intent.pending !== null} onClick={() => void retry()}>
						Try again
					</Button>
				</>
			}
		>
			You chose to {answer === "decline" ? "decline" : "accept"} this invitation, and the reply did not arrive. It may
			already be saved. Trying again sends the same answer and never answers twice.
		</Outcome>
	);
}
