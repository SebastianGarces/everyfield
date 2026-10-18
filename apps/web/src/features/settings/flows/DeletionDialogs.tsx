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
import type { DeletionStatus, SectionResult } from "../port";
import { useWrite } from "../save";
import { SaveError } from "../SettingsDialog";
import { useSettings } from "../store";

type PlantSection = Extract<SectionResult, { section: "plant" }>;
type AccountSection = Extract<SectionResult, { section: "account" }>;

const WORKSPACE_CONSEQUENCES = [
	"Everyone with a seat loses access at once, and every open session ends.",
	"People, meetings, tasks, documents and files are hidden right away. Connected organizations stop seeing what you shared.",
	"You can cancel for 30 days. After that, the church's data is deleted, and backup copies expire within 7 more days.",
	"Each person's own account stays. Their other churches and organizations are not touched.",
];

/**
 * Deleting the church workspace (REQ-IDN-026, REQ-KNOW-066): Owner only, and separate from deleting your account.
 * Typing the church name makes the choice deliberate. The request ends this session; the Owner can cancel within 30
 * days from the restricted status page.
 */
export function WorkspaceDeletionDialog({
	section,
	onRequested,
}: {
	section: PlantSection;
	onRequested: (status: DeletionStatus) => void;
}) {
	const { port } = useSettings();
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
			port.requestWorkspaceDeletion({ requestKey, expectedRevision: section.revision, input }),
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

/**
 * Deleting your own login (REQ-IDN-032): self only. Church-owned records you wrote stay with the church under a
 * minimal attribution; your photo, private check-ins and your own documents follow the account. A refusal (for an
 * Owner whose church keeps running) is shown in the dialog.
 */
export function AccountDeletionDialog({
	section,
	onRequested,
}: {
	section: AccountSection;
	onRequested: (status: DeletionStatus) => void;
}) {
	const { port } = useSettings();
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
			description={`This deletes the login for ${section.email}. Your church workspace is not deleted.`}
			consequences={[
				"You are signed out on every device at once.",
				"Records you added for your church, such as people, notes and documents, stay with the church. Your name on them is removed.",
				"Your photo, your private weekly check-ins and documents only you own are deleted after 30 days.",
				"You can cancel for 30 days by signing in again. Backup copies expire within 7 more days.",
			]}
			cancelLabel="Keep my account"
			confirmLabel="Delete my account"
			onConfirm={async () => {
				const input = { confirmed: true as const };
				const result = await write.run(input, (requestKey) =>
					port.requestAccountDeletion({ requestKey, expectedRevision: section.revision, input }),
				);
				if (!result.ok) throw new Error(`${result.refusal.message} Reference ${result.refusal.reference}.`);
				onRequested(result.value);
			}}
		/>
	);
}
