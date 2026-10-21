"use client";

import { Button, Field, Input, Skeleton } from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { useState } from "react";
import { SessionActions } from "../../identity/SessionActions";
import { AvatarControl } from "../flows/AvatarControl";
import { AccountDeletionDialog } from "../flows/DeletionDialogs";
import { EmailChange } from "../flows/EmailChange";
import { PasswordDialog } from "../flows/PasswordDialog";
import { PersonalTimezone } from "../flows/PersonalTimezone";
import type { DeletionStatus, SectionResult, SettingsViewer } from "../port";
import { attempt } from "../save";
import { SaveError, SaveFooter, SectionBody, SettingRow } from "../SettingsDialog";
import { useDraft, useSection, useSettings } from "../store";

type Account = Extract<SectionResult, { section: "account" }>;

export function AccountSection({
	onDeletionRequested,
}: {
	onDeletionRequested: (status: DeletionStatus | null) => void;
}) {
	const { state, replace, reload } = useSection({ section: "account" });
	return (
		<LoadableView
			state={state}
			empty={{ title: "" }}
			loadingLabel="Loading your account"
			skeleton={
				<SectionBody>
					<div className="flex flex-col gap-6 pt-4">
						<Skeleton shape="circle" width={56} height={56} />
						<Skeleton shape="block" height={44} />
						<Skeleton shape="block" height={44} />
					</div>
				</SectionBody>
			}
		>
			{(account) => (
				<AccountForm account={account} replace={replace} reload={reload} onDeletionRequested={onDeletionRequested} />
			)}
		</LoadableView>
	);
}

function AccountForm({
	account,
	replace,
	reload,
	onDeletionRequested,
}: {
	account: Account;
	replace: (value: SectionResult) => void;
	reload: () => void;
	onDeletionRequested: (status: DeletionStatus | null) => void;
}) {
	const { draft, setDraft, dirty, saving, refusal, save: runSave } = useDraft("account", { name: account.name });
	const [showError, setShowError] = useState(false);
	const { port, viewer } = useSettings();
	const nameError = !draft.name.trim()
		? "Enter your name."
		: draft.name.trim().length > 200
			? "Use 200 characters or fewer."
			: undefined;

	const save = () => {
		setShowError(true);
		if (nameError) return;
		void runSave(async (sent) => {
			const input = { section: "account" as const, name: sent.name.trim() };
			const result = await attempt("account-name", (requestKey) =>
				port.saveSection({ requestKey, expectedRevision: account.revision, input }),
			);
			if (!result.ok) return { ok: false, refusal: result.refusal };
			replace(result.value.current);
			const now = result.value.current.section === "account" ? result.value.current.name : account.name;
			return { ok: true, server: { name: now } };
		});
	};

	return (
		<>
			<SectionBody>
				{port.flows.avatar ? (
					<SettingRow label="Photo" description="Shown next to your name to people in your church.">
						<AvatarControl
							port={port.flows.avatar}
							account={account}
							onChanged={(avatar) => replace({ ...account, avatar })}
						/>
					</SettingRow>
				) : null}
				<SettingRow label="Name">
					<Field label={<span className="sr-only">Your name</span>} error={showError ? nameError : undefined}>
						<Input
							value={draft.name}
							onChange={(e) => setDraft({ name: e.target.value })}
							autoComplete="name"
							invalid={showError && Boolean(nameError)}
						/>
					</Field>
				</SettingRow>
				<SettingRow label="Email" description="You sign in with it. We send a link to a new address to confirm it.">
					<EmailChange currentEmail={account.email} />
				</SettingRow>
				<SettingRow label="Password" description="Changing it signs you out on your other devices.">
					<PasswordDialog />
				</SettingRow>
				<SettingRow
					label="Your time zone"
					description="Sets when your own week starts, for things only you see. Your church's time zone is separate."
				>
					<PersonalTimezone
						preference={account.personalTimezone}
						onSaved={(personalTimezone) => replace({ ...account, personalTimezone })}
					/>
				</SettingRow>
				<SettingRow label="Delete your account" description={deletionText(viewer)}>
					{ownsSeat(viewer) ? null : <AccountDeletionDialog section={account} onRequested={onDeletionRequested} />}
				</SettingRow>
				<SettingRow label="Sessions" description="Sign out here, or on every other device at once.">
					<SessionActions />
				</SettingRow>
			</SectionBody>
			<SaveFooter
				section="account"
				dirty={dirty}
				saving={saving}
				onSave={save}
				error={
					refusal ? (
						<SaveError
							message={refusal.message}
							reference={refusal.reference}
							action={
								refusal.code === "conflict" || refusal.code === "unknown" ? (
									<Button size="sm" variant="secondary" onClick={reload}>
										Load latest
									</Button>
								) : undefined
							}
						/>
					) : undefined
				}
			/>
		</>
	);
}

/** An Owner's account keeps the church running, so it cannot be deleted here (manual_owner_exception_required). */
const ownsSeat = (viewer: SettingsViewer) => viewer.context !== "account" && viewer.role === "owner";

function deletionText(viewer: SettingsViewer): string {
	return ownsSeat(viewer)
		? "You are an Owner, so your church needs another Owner first. Write to Everyfield support to arrange it."
		: "Deletes your login only, not your church. You have 30 days to change your mind.";
}
