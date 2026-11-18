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
import { useCallback, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useOneTimeLinkValue } from "../../../components/location.ts";
import { NotAvailable } from "../../access/AccessStates";
import { Refusal, useIntent, useLoad } from "../../../components/intent.ts";
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
import { FullPageLink } from "@/components/native";

const PAGE = "/invitation";

type Session = Awaited<ReturnType<typeof readInvitation>>["session"];
type Read = { description: ReturnType<typeof invitationDescriptionResult.parse>; session: Session };

export function InvitationScreen() {
	const proof = useOneTimeLinkValue("invitation");
	if (proof === undefined) return <Loading />;
	if (!proof) return <Unavailable />;
	return <InvitationFor key={proof} proof={proof} />;
}

function InvitationFor({ proof }: { proof: string }) {
	const fetch = useCallback(async (): Promise<Read> => {
		const r = await readInvitation(proof);
		return { description: invitationDescriptionResult.parse(r.description), session: r.session };
	}, [proof]);
	const { state, reload, update, refreshing } = useLoad(fetch, "The invitation did not load");
	const [held, setHeld] = useState<Held | null>(() => tabStore.held(proof));
	const [joining, setJoining] = useState<string | null>(() => tabStore.joining());

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
	const joined = async (email: string): Promise<Read | null> => {
		tabStore.setJoining(email);
		setJoining(email);
		try {
			const fresh = await fetch();
			update(() => fresh);
			return fresh;
		} catch {
			reload();
			return null;
		}
	};
	const signedIn = session !== "signed_out";
	const answer = {
		description,
		proof,
		refreshing,
		onRefused: reload,
		onHeld: setHeld,
		joining,
	};
	if (description.subject.purpose === "seat") return <SeatFlow {...answer} signedIn={signedIn} onJoined={joined} />;
	if (!signedIn) return <SignedOut description={description} proof={proof} onJoined={joined} />;
	return <ResidentAnswer {...answer} />;
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

function SignedOut({
	description,
	proof,
	onJoined,
}: {
	description: Description;
	proof: string;
	onJoined: (email: string) => void;
}) {
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
				onJoined={onJoined}
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

const INLINE = "rounded-md font-semibold text-ink underline-offset-4 hover:underline disabled:opacity-60";

function JoinForm({
	proof,
	submitLabel,
	onJoined,
	onSignInNeeded,
}: {
	proof: string;
	submitLabel: string;
	onJoined: (email: string) => void;
	onSignInNeeded: (email: string) => void;
}) {
	const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
	const [refusal, setRefusal] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
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
		const signedIn = await identityApi.signIn({ email: email.data, password });
		if (signedIn.ok) {
			onJoined(email.data);
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

function refusedText(code: string | null): string {
	if (code === "temporary") return "Someone is changing this invitation right now. Try again in a moment.";
	return "This invitation cannot be accepted with this account. Sign in with the account for the invited address, and confirm that address first.";
}

async function sendSeat(command: SeatCommand) {
	const reply = await acceptSeatInvitation(command);
	if (reply.status === "refused") throw new Refusal(reply.code);
	return seatInvitationAcceptedResult.parse(reply.value);
}

async function sendResident(command: ResidentCommand): Promise<ResidentDone> {
	const reply = await respondResidentInvitation(command);
	if (reply.status === "refused" && reply.code === "already_linked") return { status: "already_linked" };
	if (reply.status === "refused") throw new Refusal(reply.code);
	return residentInvitationDecisionResult.parse(reply.value);
}

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
	refreshing: boolean;
	onRefused: () => void;
	onHeld: (held: Held) => void;
	joining: string | null;
};

type SeatAccepted = ReturnType<typeof seatInvitationAcceptedResult.parse>;

function SeatFlow({
	description,
	proof,
	refreshing,
	onRefused,
	onHeld,
	joining,
	signedIn,
	onJoined,
}: AnswerProps & { signedIn: boolean; onJoined: (email: string) => Promise<Read | null> }) {
	const intent = useIntent<SeatCommand>("seat-accept");
	const [done, setDone] = useState<SeatAccepted | null>(null);
	const [confirm, setConfirm] = useState<{ tries: number } | null>(null);
	const link = useConfirmationLink();
	const role = description.subject.purpose === "seat" ? description.subject.role : "member";

	async function accept(asJoining: string | null, to: Description = description) {
		setConfirm((c) => c && { tries: c.tries + 1 });
		const result = await intent.run(
			to.invitationId,
			(requestKey) =>
				acceptSeatInvitationRequest.parse({
					requestKey,
					expectedRevision: to.revision,
					input: { invitationId: to.invitationId, proof },
				}),
			holding(
				(command: SeatCommand) => tabStore.hold({ proof, workspaceName: to.workspaceName, kind: "seat", command }),
				async (command: SeatCommand) => {
					try {
						return await sendSeat(command);
					} catch (e) {
						if (e instanceof Refusal && e.code !== "temporary" && asJoining) {
							if (!confirm) void link.send(asJoining);
							setConfirm((c) => c ?? { tries: 1 });
						}
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
	}

	if (!signedIn)
		return (
			<SignedOut
				description={description}
				proof={proof}
				onJoined={async (email) => {
					const fresh = await onJoined(email);
					if (
						fresh?.description.status === "pending" &&
						fresh.session !== "signed_out" &&
						fresh.session !== "unavailable"
					)
						void accept(email, fresh.description);
				}}
			/>
		);
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
	if (joining && confirm)
		return (
			<ConfirmEmail
				email={joining}
				busy={intent.pending !== null || refreshing}
				stillRefused={confirm.tries > 1 && intent.problem === "refused"}
				sent={link.sent}
				onSend={() => void link.send(joining)}
				onContinue={() => void accept(joining)}
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
				onClick={() => void accept(joining)}
			>
				Accept and join
			</Button>
			<SignOutLine />
		</>
	);
}

type LinkSent = "idle" | "sending" | "sent" | "failed";

function ConfirmEmail({
	email,
	busy,
	stillRefused,
	sent,
	onSend,
	onContinue,
}: {
	email: string;
	busy: boolean;
	stillRefused: boolean;
	sent: LinkSent;
	onSend: () => void;
	onContinue: () => void;
}) {
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
					<Button variant="ghost" className="w-full" loading={sent === "sending"} onClick={onSend}>
						Send the link again
					</Button>
				</>
			}
		>
			Open the confirmation link in your email. Then come back to this page and select Continue.
		</Outcome>
	);
}

function useConfirmationLink() {
	const [sent, setSent] = useState<LinkSent>("idle");
	const send = async (email: string) => {
		setSent("sending");
		const r = await identityApi.sendVerification(email);
		setSent(r.ok ? "sent" : "failed");
	};
	return { sent, send };
}

function ConfirmHint({ email }: { email: string }) {
	const { sent, send } = useConfirmationLink();
	return (
		<div className="mt-3 flex flex-col gap-3">
			<FormMessage tone="success">
				{sent === "sent" ? `We sent a link to ${email}. Open it, then select Accept and join again.` : null}
			</FormMessage>
			<FormMessage tone="error">
				{sent === "failed" ? "The link was not sent. Check your connection and try again." : null}
			</FormMessage>
			<Button variant="secondary" loading={sent === "sending"} onClick={() => void send(email)}>
				Send a confirmation link to {email}
			</Button>
		</div>
	);
}

type ResidentDone = ReturnType<typeof residentInvitationDecisionResult.parse> | { status: "already_linked" };

function ResidentAnswer({ description, proof, refreshing, onRefused, onHeld, joining }: AnswerProps) {
	const intent = useIntent<ResidentCommand>("resident-answer");
	const [done, setDone] = useState<ResidentDone | null>(null);

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
	if (done.status === "already_linked")
		return (
			<Outcome
				icon={CheckmarkCircle02Icon}
				tone="green"
				title={`You’re already linked to ${organizationName}`}
				actions={
					<Button asChild variant="primary" className="w-full">
						<a href="/my-residency">Open My residency</a>
					</Button>
				}
			>
				You accepted this invitation in another tab or window, so nothing changed here. Your sharing choices are the
				ones you made there.
			</Outcome>
		);
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
				<>
					<Button asChild variant="primary" className="w-full">
						<a href="/my-residency">Open My residency</a>
					</Button>
					<Button asChild variant="secondary" className="w-full">
						<FullPageLink href="/settings/sharing">Review your sharing</FullPageLink>
					</Button>
				</>
			}
		>
			{shared.length ? `You share your ${shared.join(" and ")}.` : "You share nothing yet."} This link does not give you
			a seat. You can change what you share at any time.
		</Outcome>
	);
}

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
