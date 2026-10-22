"use client";

import { inviteRelationshipRequest } from "@everyfield/contracts/organizations";
import { HierarchyIcon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTrigger,
	Field,
	Input,
	Select,
	Skeleton,
} from "@everyfield/ui/controls";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { SharingDisclosure } from "./Disclosure";
import { useIntent } from "./intent";
import { emailProblem, kindLabel } from "./model";
import { ProblemLine } from "./parts";
import type { Disclosure, Invitation, Organization, RelationshipPair, Run } from "./port";

/** One organization this subject may ask to connect with. */
export type InviteTarget = { pair: RelationshipPair; name: string };

/** Reads the exact disclosure the server will apply for this pair (readSharingDisclosure), or null when it has none. */
export type ReadDisclosure = (pair: RelationshipPair) => Promise<Disclosure | null>;

const REFUSED: Record<string, string> = {
	pending_invitation: "A request to this organization is already waiting. Resend it from the list instead.",
	address_pending:
		"An invitation to this email address is already waiting for an answer. Enter another Owner or Admin's email.",
	already_active: "You are already connected with this organization.",
	invitation_limit: "This address has had 3 invitations in the last 30 days. Ask another Owner or Admin there.",
	stale_revision: "Your details changed since this page loaded. Close this, then try again.",
};

/**
 * Asking one exact organization to connect (REQ-IDN-020). The subject's Owner or Admin picks the organization and
 * the address of its Owner or Admin, and sees what that organization will be able to see before sending
 * (REQ-IDN-022). Nothing is shared until the organization accepts. When the reply is lost, the fields lock and
 * Try again resends the same command; closing the dialog then asks the list to reload.
 */
export function InviteDialog({
	targets,
	readDisclosure,
	expectedRevision,
	run,
	onSent,
	onUnconfirmed,
	trigger,
}: {
	targets: InviteTarget[];
	readDisclosure: ReadDisclosure;
	/** The subject's current revision, so a stale screen cannot send. */
	expectedRevision: string;
	run: Run;
	onSent: (invitation: Invitation, target: InviteTarget) => void;
	onUnconfirmed: () => void;
	trigger: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [targetId, setTargetId] = useState<string>("");
	const [email, setEmail] = useState("");
	const [checked, setChecked] = useState(false);
	// The address of the last send, so an address_pending refusal marks the field only while it still holds that address.
	const [sentEmail, setSentEmail] = useState("");
	// `failed`: the read did not answer. A plant must see its disclosure before it can send (REQ-IDN-022); other
	// subjects have none, so `value: null` with no failure lets them send. Each opening of the dialog is a new
	// `attempt`, and a disclosure read in an earlier attempt never counts.
	const [disclosure, setDisclosure] = useState<{
		attempt: number;
		id: string;
		value: Disclosure | null;
		failed: boolean;
	} | null>(null);
	const [attempt, setAttempt] = useState(0);
	const send = useIntent<ReturnType<typeof inviteRelationshipRequest.parse>>("relationship-invite");
	const locked = send.held !== null || send.pending !== null;
	// The address_pending refusal names a fix the person must make, so focus moves to it; the fields stay editable.
	const refusal = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (send.code === "address_pending") refusal.current?.focus();
	}, [send.code]);
	const target = targets.find((t) => t.pair.organization.id === targetId);
	const errors = { organization: target ? undefined : "Choose an organization.", email: emailProblem(email) };
	const shown: Partial<typeof errors> = checked ? errors : {};

	useEffect(() => {
		if (!target) return;
		let live = true;
		readDisclosure(target.pair).then(
			(value) => live && setDisclosure({ attempt, id: target.pair.organization.id, value, failed: false }),
			() => live && setDisclosure({ attempt, id: target.pair.organization.id, value: null, failed: true }),
		);
		return () => {
			live = false;
		};
	}, [target, readDisclosure, attempt]);
	const shownDisclosure =
		disclosure && disclosure.attempt === attempt && disclosure.id === targetId ? disclosure : null;
	const needsDisclosure = target?.pair.kind === "plant";
	const disclosureMissing = needsDisclosure && shownDisclosure !== null && shownDisclosure.value === null;
	// Sending waits until a plant has seen exactly what this organization will see.
	const ready = !target || !needsDisclosure || Boolean(shownDisclosure?.value);

	const change = (next: boolean) => {
		if (send.pending) return;
		setOpen(next);
		// Opening or closing starts a fresh attempt: the disclosure is read again before anything can be sent.
		setAttempt((n) => n + 1);
		setDisclosure(null);
		if (!next) {
			if (send.held) onUnconfirmed();
			setTargetId("");
			setEmail("");
			setChecked(false);
			send.release();
		}
	};

	const submit = async () => {
		setChecked(true);
		if (!target || errors.email || !ready) return;
		setSentEmail(email);
		const result = await send.run(
			"dialog",
			(requestKey) =>
				inviteRelationshipRequest.parse({
					requestKey,
					expectedRevision,
					input: { pair: target.pair, recipientEmail: email },
				}),
			(command) => run("associations.invite", command),
			() => true,
		);
		if (result.ok) {
			onSent(result.reply, target);
			change(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent size="md">
				<DialogHeader
					icon={HierarchyIcon}
					tone="blue"
					title="Connect with an organization"
					description="We email their Owner or Admin. Nothing is shared until they accept."
				/>
				<DialogBody>
					<form
						id="invite-organization"
						noValidate
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
						className="flex flex-col gap-5 pb-1"
					>
						<Field label="Organization" error={shown.organization}>
							<Select
								value={targetId}
								onValueChange={setTargetId}
								disabled={locked}
								placeholder="Choose a sending church or network"
								invalid={Boolean(shown.organization)}
								options={targets.map((t) => ({
									value: t.pair.organization.id,
									label: `${t.name} · ${kindLabel(t.pair.organization as Organization)}`,
								}))}
							/>
						</Field>
						<Field
							label="Their Owner or Admin's email"
							hint="The invitation link works for 30 days."
							error={shown.email}
						>
							<Input
								type="email"
								autoComplete="off"
								spellCheck={false}
								value={email}
								readOnly={locked}
								onChange={(e) => setEmail(e.target.value)}
								invalid={Boolean(shown.email) || (send.code === "address_pending" && email === sentEmail)}
							/>
						</Field>
						<ProblemLine
							focusRef={refusal}
							problem={send.problem}
							refused={REFUSED[send.code ?? ""] ?? "This invitation was not sent. Nothing changed."}
						/>
						{target ? (
							shownDisclosure ? (
								shownDisclosure.value ? (
									<SharingDisclosure disclosure={shownDisclosure.value} organizationName={target.name} />
								) : disclosureMissing ? (
									<div
										role="alert"
										className="flex flex-wrap items-center gap-3 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600"
									>
										<p className="min-w-0 flex-1">
											{shownDisclosure.failed
												? `What ${target.name} would see did not load. Nothing was sent.`
												: `${target.name} cannot be asked from here right now. Nothing was sent.`}
										</p>
										{shownDisclosure.failed ? (
											<Button
												size="sm"
												variant="secondary"
												onClick={() => {
													setAttempt((n) => n + 1);
													setDisclosure(null);
												}}
											>
												Try again
											</Button>
										) : null}
									</div>
								) : null
							) : (
								<div aria-busy="true">
									<span className="sr-only" role="status">
										Loading what {target.name} can see
									</span>
									<Skeleton shape="block" height={120} />
								</div>
							)
						) : null}
					</form>
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={() => change(false)} disabled={send.pending !== null}>
						{send.held ? "Close" : "Cancel"}
					</Button>
					<Button
						variant="primary"
						type="submit"
						form="invite-organization"
						disabled={!ready}
						loading={send.pending !== null}
					>
						{send.held ? "Try again" : "Send invitation"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
