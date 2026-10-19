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
} from "@everyfield/ui/controls";
import { useState, type ReactNode } from "react";
import { SharingDisclosure } from "./Disclosure";
import { useIntent } from "./intent";
import { emailProblem, kindLabel } from "./model";
import { ProblemLine } from "./parts";
import type { Disclosure, Invitation, Organization, RelationshipPair, Run } from "./port";

/** One organization this subject may ask to connect with, with the exact disclosure the server will apply. */
export type InviteTarget = { pair: RelationshipPair; name: string; disclosure: Disclosure };

/**
 * Asking one exact organization to connect (REQ-IDN-020). The subject's Owner or Admin picks the organization and
 * the address of its Owner or Admin, and sees what that organization will be able to see before sending
 * (REQ-IDN-022). Nothing is shared until the organization accepts.
 */
export function InviteDialog({
	targets,
	expectedRevision,
	run,
	onSent,
	trigger,
}: {
	targets: InviteTarget[];
	/** The subject's current revision, so a stale screen cannot send. */
	expectedRevision: string;
	run: Run;
	onSent: (invitation: Invitation, target: InviteTarget) => void;
	trigger: ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const [targetId, setTargetId] = useState<string>("");
	const [email, setEmail] = useState("");
	const [checked, setChecked] = useState(false);
	const { run: send, pending, problem, reset } = useIntent("relationship-invite");
	const target = targets.find((t) => t.pair.organization.id === targetId);
	const errors = { organization: target ? undefined : "Choose an organization.", email: emailProblem(email) };
	const shown: Partial<typeof errors> = checked ? errors : {};

	const change = (next: boolean) => {
		if (pending) return;
		setOpen(next);
		if (!next) {
			setTargetId("");
			setEmail("");
			setChecked(false);
			reset();
		}
	};

	const submit = async () => {
		setChecked(true);
		if (!target || errors.email) return;
		const result = await send(
			(requestKey) =>
				run(
					"associations.invite",
					inviteRelationshipRequest.parse({
						requestKey,
						expectedRevision,
						input: { pair: target.pair, recipientEmail: email },
					}),
				),
			// The contract has no refusal result for an invitation; a refusal arrives as an error.
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
								onChange={(e) => setEmail(e.target.value)}
								invalid={Boolean(shown.email)}
							/>
						</Field>
						{target ? <SharingDisclosure disclosure={target.disclosure} organizationName={target.name} /> : null}
					</form>
					<ProblemLine problem={problem} />
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={() => change(false)} disabled={pending}>
						Cancel
					</Button>
					<Button variant="primary" type="submit" form="invite-organization" loading={pending}>
						Send invitation
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
