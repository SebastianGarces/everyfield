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
import { useEffect, useState, type ReactNode } from "react";
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
	const [disclosure, setDisclosure] = useState<{ id: string; value: Disclosure | null } | null>(null);
	const send = useIntent<ReturnType<typeof inviteRelationshipRequest.parse>>("relationship-invite");
	const locked = send.held !== null || send.pending !== null;
	const target = targets.find((t) => t.pair.organization.id === targetId);
	const errors = { organization: target ? undefined : "Choose an organization.", email: emailProblem(email) };
	const shown: Partial<typeof errors> = checked ? errors : {};

	useEffect(() => {
		if (!target) return;
		let live = true;
		readDisclosure(target.pair).then(
			(value) => live && setDisclosure({ id: target.pair.organization.id, value }),
			() => live && setDisclosure({ id: target.pair.organization.id, value: null }),
		);
		return () => {
			live = false;
		};
	}, [target, readDisclosure]);
	const shownDisclosure = disclosure && disclosure.id === targetId ? disclosure : null;

	const change = (next: boolean) => {
		if (send.pending) return;
		setOpen(next);
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
		if (!target || errors.email) return;
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
								invalid={Boolean(shown.email)}
							/>
						</Field>
						<ProblemLine
							problem={send.problem}
							refused={REFUSED[send.code ?? ""] ?? "This invitation was not sent. Nothing changed."}
						/>
						{target ? (
							shownDisclosure ? (
								shownDisclosure.value ? (
									<SharingDisclosure disclosure={shownDisclosure.value} organizationName={target.name} />
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
					<Button variant="primary" type="submit" form="invite-organization" loading={send.pending !== null}>
						{send.held ? "Try again" : "Send invitation"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
