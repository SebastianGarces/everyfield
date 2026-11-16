"use client";

import { Delete02Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	ConfirmDialog,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTrigger,
	Field,
	Input,
} from "@everyfield/ui/controls";
import { useState } from "react";
import type { DeletionStatus, FlowPort, SectionResult } from "../port";
import { useWrite } from "../save";
import { SaveError } from "../SettingsDialog";
import { useFlows } from "../store";

type PlantSection = Extract<SectionResult, { section: "plant" }>;
type AccountSection = Extract<SectionResult, { section: "account" }>;

export const OUT_OF_REACH =
	"Some copies are out of our reach. Emails already accepted for delivery still arrive. File links given out before the request work until they expire a short time later. Other services we use delete their copies on their own schedule. Copies someone downloaded or posted elsewhere stay where they are.";

const WORKSPACE_CONSEQUENCES = [
	"Everyone with a seat loses access at once, and every open session ends.",
	"People, meetings, tasks, documents and files are hidden right away. Connected organizations stop seeing what you shared.",
	"You can cancel for 30 days. After that, the church's data is deleted. Backup copies expire within 7 days after the deletion finishes.",
	"Some copies are out of our reach. Emails already accepted for delivery still arrive. File links given out before the request work until they expire a short time later. Other services we use delete their copies on their own schedule. Copies someone downloaded or posted elsewhere stay where they are.",
	"Each person's own account stays. Their other churches and organizations are not touched.",
];

export function WorkspaceDeletionDialog({
	section,
	request,
	onRequested,
}: {
	section: PlantSection;
	request: NonNullable<FlowPort["requestWorkspaceDeletion"]>;
	onRequested: (status: DeletionStatus) => void;
}) {
	const [open, setOpen] = useState(false);
	const [typed, setTyped] = useState("");
	const write = useWrite("workspace-deletion");
	const name = section.values.profile.name;
	const matches = typed.trim().toLowerCase() === name.trim().toLowerCase();

	const change = (next: boolean) => {
		if (write.pending) return;
		setOpen(next);
		if (!next) {
			setTyped("");
			write.setRefusal(null);
		}
	};

	const confirm = async () => {
		if (!matches) return;
		const input = { plant: section.plant, confirmed: true as const };
		const result = await write.run(input, (requestKey) =>
			request({ requestKey, expectedRevision: section.revision, input }),
		);
		if (result.ok) onRequested(result.value);
	};

	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogTrigger asChild>
				<Button variant="danger" size="sm" icon={Delete02Icon}>
					Delete church workspace
				</Button>
			</DialogTrigger>
			<DialogContent size="sm" role="alertdialog">
				<DialogHeader
					icon={Delete02Icon}
					tone="magenta"
					title={`Delete ${name}?`}
					description="This deletes the church workspace for everyone, not only your account."
				/>
				<DialogBody className="flex flex-col gap-4">
					<ul className="flex flex-col gap-2 rounded-md bg-surface px-5 py-4 text-text-2">
						{WORKSPACE_CONSEQUENCES.map((c) => (
							<li key={c} className="flex gap-2.5">
								<span aria-hidden="true" className="mt-[9px] size-1.5 flex-none rounded-full bg-text-3" />
								{c}
							</li>
						))}
					</ul>
					<Field label={`Type ${name} to confirm`}>
						<Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
					</Field>
					{write.refusal ? <SaveError message={write.refusal.message} reference={write.refusal.reference} /> : null}
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={() => change(false)} disabled={write.pending}>
						Keep the workspace
					</Button>
					<Button variant="danger" onClick={confirm} loading={write.pending} disabled={!matches}>
						Delete workspace
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function AccountDeletionDialog({
	section,
	onRequested,
}: {
	section: AccountSection;
	onRequested: (status: DeletionStatus | null) => void;
}) {
	const port = useFlows();
	const [open, setOpen] = useState(false);
	const write = useWrite("account-deletion");
	return (
		<ConfirmDialog
			open={open}
			onOpenChange={setOpen}
			trigger={
				<Button variant="danger" size="sm" icon={Delete02Icon}>
					Delete your account
				</Button>
			}
			tone="danger"
			title="Delete your account?"
			description={`This deletes the login for ${section.email}. Your church workspace stays.`}
			consequences={[
				"You are signed out on every device at once.",
				"Records you added for your church, such as people, notes and documents, stay with the church. Your name on them is removed.",
				"Your photo, your private weekly check-ins and documents only you own are deleted after 30 days.",
				"For 30 days you can cancel on the account deletion page with your email and password. Backup copies expire within 7 days after the deletion finishes.",
				OUT_OF_REACH,
			]}
			cancelLabel="Keep my account"
			confirmLabel="Delete my account"
			onConfirm={async () => {
				const input = { confirmed: true as const };
				const result = await write.run(input, (requestKey) =>
					port.requestAccountDeletion({ requestKey, expectedRevision: section.revision, input }),
				);
				if (result.ok) return onRequested(result.value);
				if (UNCERTAIN.has(result.refusal.code)) return onRequested(null);
				throw new Error(`${result.refusal.message} Reference ${result.refusal.reference}.`);
			}}
		/>
	);
}

const UNCERTAIN = new Set(["unknown", "access_denied"]);
