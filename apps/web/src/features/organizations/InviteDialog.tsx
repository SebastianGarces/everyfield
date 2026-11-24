"use client";

import { inviteRelationshipRequest } from "@everyfield/contracts/organizations";
import { HierarchyIcon } from "@hugeicons/core-free-icons";
import {
	Alert,
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
import { focusOnMount } from "@everyfield/ui/foundations";
import { useState, type ReactNode } from "react";
import { SharingDisclosure } from "./Disclosure";
import { useIntent } from "../../components/intent.ts";
import { emailProblem, kindLabel } from "./model";
import { ProblemLine } from "./parts";
import type { Disclosure, Organization, RelationshipPair, SendInvitation, SentInvitation } from "./port";
import { READ_FAILED, thrownRead } from "../../components/read-failed.ts";

export type InviteTarget = { pair: RelationshipPair; name: string };

export type ReadDisclosure = (pair: RelationshipPair) => Promise<Disclosure | null>;

const REFUSED: Record<string, string> = {
	pending_invitation: "A request to this organization is already waiting. Resend it from the list instead.",
	address_pending:
		"An invitation to this email address is already waiting for an answer. Enter another Owner or Admin's email.",
	already_active: "You are already connected with this organization.",
	invitation_limit: "This address has had 3 invitations in the last 30 days. Ask another Owner or Admin there.",
	stale_revision: "Your details changed since this page loaded. Close this, then try again.",
};

export function InviteDialog({
	targets,
	readDisclosure,
	expectedRevision,
	sendInvitation,
	onSent,
	onUnconfirmed,
	trigger,
}: {
	targets: InviteTarget[];
	readDisclosure: ReadDisclosure;
	expectedRevision: string;
	sendInvitation: SendInvitation;
	onSent: (sent: SentInvitation, target: InviteTarget) => void;
	onUnconfirmed: () => void;
	trigger: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const send = useIntent<InviteCommand>("relationship-invite");

	const change = (next: boolean) => {
		if (send.pending) return;
		setOpen(next);
		if (!next) {
			if (send.held) onUnconfirmed();
			send.release();
		}
	};

	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogTrigger asChild>{trigger}</DialogTrigger>
			<DialogContent size="md">
				<InviteForm
					targets={targets}
					readDisclosure={readDisclosure}
					expectedRevision={expectedRevision}
					sendInvitation={sendInvitation}
					send={send}
					onSent={(sent, target) => {
						onSent(sent, target);
						change(false);
					}}
					onCancel={() => change(false)}
				/>
			</DialogContent>
		</Dialog>
	);
}

type InviteCommand = ReturnType<typeof inviteRelationshipRequest.parse>;
type DisclosureRead = { asked: object; id: string } & (
	{ status: "loading" } | { status: "ready"; value: Disclosure | null } | { status: "failed"; read: "lost" | "failed" }
);

function InviteForm({
	targets,
	readDisclosure,
	expectedRevision,
	sendInvitation,
	send,
	onSent,
	onCancel,
}: {
	targets: InviteTarget[];
	readDisclosure: ReadDisclosure;
	expectedRevision: string;
	sendInvitation: SendInvitation;
	send: ReturnType<typeof useIntent<InviteCommand>>;
	onSent: (sent: SentInvitation, target: InviteTarget) => void;
	onCancel: () => void;
}) {
	const [targetId, setTargetId] = useState<string>("");
	const [email, setEmail] = useState("");
	const [attempted, setAttempted] = useState<string | null>(null);
	const [disclosure, setDisclosure] = useState<DisclosureRead | null>(null);
	const locked = send.held !== null || send.pending !== null;
	const target = targets.find((t) => t.pair.organization.id === targetId);
	const errors = { organization: target ? undefined : "Choose an organization.", email: emailProblem(email) };
	const shown: Partial<typeof errors> = attempted !== null ? errors : {};

	const needsDisclosure = target?.pair.kind === "plant";
	const shownDisclosure = disclosure && disclosure.id === targetId ? disclosure : null;
	const ready = !target || !needsDisclosure || (shownDisclosure?.status === "ready" && shownDisclosure.value !== null);

	const askDisclosure = (picked: InviteTarget) => {
		const asked = {};
		const id = picked.pair.organization.id;
		const answer = (next: DisclosureRead) => setDisclosure((d) => (d?.asked === asked ? next : d));
		setDisclosure({ asked, id, status: "loading" });
		readDisclosure(picked.pair).then(
			(value) => answer({ asked, id, status: "ready", value }),
			(error: unknown) => answer({ asked, id, status: "failed", read: thrownRead(error).status }),
		);
	};

	const pick = (id: string) => {
		setTargetId(id);
		const picked = targets.find((t) => t.pair.organization.id === id);
		if (picked?.pair.kind === "plant") askDisclosure(picked);
	};

	const submit = async () => {
		setAttempted(email);
		if (!target || errors.email || !ready) return;
		const result = await send.run(
			"dialog",
			(requestKey) =>
				inviteRelationshipRequest.parse({
					requestKey,
					expectedRevision,
					input: { pair: target.pair, recipientEmail: email },
				}),
			(command) => sendInvitation("associations.invite", command),
			() => true,
		);
		if (result.ok) onSent(result.reply, target);
	};

	return (
		<>
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
							onValueChange={pick}
							disabled={locked}
							placeholder="Choose a sending church or network"
							invalid={Boolean(shown.organization)}
							options={targets.map((t) => ({
								value: t.pair.organization.id,
								label: `${t.name} · ${kindLabel(t.pair.organization as Organization)}`,
							}))}
						/>
					</Field>
					<Field label="Their Owner or Admin's email" hint="The invitation link works for 30 days." error={shown.email}>
						<Input
							type="email"
							autoComplete="off"
							spellCheck={false}
							value={email}
							readOnly={locked}
							onChange={(e) => setEmail(e.target.value)}
							invalid={Boolean(shown.email) || (send.code === "address_pending" && email === attempted)}
						/>
					</Field>
					<ProblemLine
						focusRef={send.code === "address_pending" ? focusOnMount : undefined}
						problem={send.problem}
						refused={REFUSED[send.code ?? ""] ?? "This invitation was not sent. Nothing changed."}
					/>
					{target && needsDisclosure ? (
						shownDisclosure && shownDisclosure.status !== "loading" ? (
							shownDisclosure.status === "ready" && shownDisclosure.value ? (
								<SharingDisclosure disclosure={shownDisclosure.value} organizationName={target.name} />
							) : (
								<Alert
									role="alert"
									actions={
										shownDisclosure.status === "failed" ? (
											<Button size="sm" variant="secondary" onClick={() => askDisclosure(target)}>
												Try again
											</Button>
										) : undefined
									}
								>
									{shownDisclosure.status === "failed"
										? shownDisclosure.read === "failed"
											? READ_FAILED
											: `What ${target.name} would see did not load. Nothing was sent.`
										: `${target.name} cannot be asked from here right now. Nothing was sent.`}
								</Alert>
							)
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
				<Button variant="secondary" onClick={onCancel} disabled={send.pending !== null}>
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
		</>
	);
}
