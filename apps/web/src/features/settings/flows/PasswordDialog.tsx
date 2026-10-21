"use client";

import { LockPasswordIcon } from "@hugeicons/core-free-icons";
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
} from "@everyfield/ui/controls";
import { useRef, useState } from "react";
import type { CredentialOutcome } from "../port";
import { useFlows } from "../store";

type Form = { currentPassword: string; newPassword: string; confirmPassword: string };
const EMPTY: Form = { currentPassword: "", newPassword: "", confirmPassword: "" };

export function passwordProblems(form: Form): Partial<Record<keyof Form, string>> {
	const problems: Partial<Record<keyof Form, string>> = {};
	if (!form.currentPassword) problems.currentPassword = "Enter your current password.";
	if (form.newPassword.length < 8) problems.newPassword = "Use at least 8 characters.";
	else if (form.newPassword.length > 1024) problems.newPassword = "Use 1,024 characters or fewer.";
	if (form.confirmPassword !== form.newPassword) problems.confirmPassword = "The passwords do not match.";
	return problems;
}

type Failure = Exclude<CredentialOutcome["status"], "succeeded">;
const OUTCOME_TEXT: Record<Failure, string> = {
	refused:
		"Your password did not change. Check your current password, and make the new one different from it. After several tries you need to wait 15 minutes.",
	unknown:
		"We could not confirm whether your password changed. Do not try again yet: sign out, then sign in to see which password works.",
};

/**
 * Changing your password (REQ-IDN-008). It needs the current password. Success signs out your other devices and
 * keeps this one. Passwords live only in this dialog's state: they are cleared when it closes and never retried.
 */
export function PasswordDialog() {
	const port = useFlows();
	const [open, setOpen] = useState(false);
	const [form, setForm] = useState<Form>(EMPTY);
	const [checked, setChecked] = useState(false);
	const [pending, setPending] = useState(false);
	const [failure, setFailure] = useState<Failure | null>(null);
	const [done, setDone] = useState(false);
	const problems = checked ? passwordProblems(form) : {};
	const currentRef = useRef<HTMLInputElement>(null);
	const newRef = useRef<HTMLInputElement>(null);
	const confirmRef = useRef<HTMLInputElement>(null);
	// The first field with a problem takes focus, so its message is read with it.
	const focusFirst = (keys: (keyof Form)[]) =>
		({ currentPassword: currentRef, newPassword: newRef, confirmPassword: confirmRef })[keys[0]!].current?.focus();

	const change = (next: boolean) => {
		if (pending) return;
		setOpen(next);
		setForm(EMPTY);
		setChecked(false);
		setFailure(null);
	};

	const submit = async () => {
		setChecked(true);
		if (pending) return;
		const found = Object.keys(passwordProblems(form)) as (keyof Form)[];
		if (found.length > 0) return focusFirst(found);
		setPending(true);
		// A lost connection is the same as an unknown outcome: the change may have happened.
		let status: CredentialOutcome["status"];
		try {
			status = (await port.changePassword(form)).status;
		} catch {
			status = "unknown";
		}
		setPending(false);
		if (status === "succeeded") {
			setDone(true);
			change(false);
			return;
		}
		setFailure(status);
		setForm(status === "unknown" ? EMPTY : { ...form, currentPassword: "" });
		// The alert explains the refusal; the emptied field shows no second message.
		setChecked(false);
		if (status === "refused") focusFirst(["currentPassword"]);
	};

	const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

	return (
		<div className="flex flex-wrap items-center gap-3">
			<Dialog open={open} onOpenChange={change}>
				<DialogTrigger asChild>
					<Button size="sm" variant="secondary">
						Change password
					</Button>
				</DialogTrigger>
				<DialogContent size="sm">
					<DialogHeader
						icon={LockPasswordIcon}
						title="Change password"
						description="Your other devices are signed out. This one stays signed in."
					/>
					<form
						id="change-password"
						className="contents"
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
					>
						<DialogBody className="flex flex-col gap-4">
							<Field label="Current password" error={problems.currentPassword}>
								<Input
									ref={currentRef}
									type="password"
									autoComplete="current-password"
									value={form.currentPassword}
									onChange={set("currentPassword")}
								/>
							</Field>
							<Field label="New password" hint="At least 8 characters." error={problems.newPassword}>
								<Input
									ref={newRef}
									type="password"
									autoComplete="new-password"
									value={form.newPassword}
									onChange={set("newPassword")}
								/>
							</Field>
							<Field label="Repeat new password" error={problems.confirmPassword}>
								<Input
									ref={confirmRef}
									type="password"
									autoComplete="new-password"
									value={form.confirmPassword}
									onChange={set("confirmPassword")}
								/>
							</Field>
							{failure ? (
								<p role="alert" className="rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
									{OUTCOME_TEXT[failure]}
								</p>
							) : null}
						</DialogBody>
						<DialogFooter>
							<Button variant="secondary" onClick={() => change(false)} disabled={pending}>
								Cancel
							</Button>
							<Button type="submit" variant="primary" loading={pending} disabled={failure === "unknown"}>
								Change password
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<span role="status" className="text-sm text-text-3">
				{done ? "Password changed. Your other devices are signed out." : null}
			</span>
		</div>
	);
}
