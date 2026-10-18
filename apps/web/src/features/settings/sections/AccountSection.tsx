"use client";

import { Button, Field, Input, Skeleton } from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { useState } from "react";
import { AvatarControl } from "../flows/AvatarControl";
import { AccountDeletionDialog } from "../flows/DeletionDialogs";
import { EmailChange } from "../flows/EmailChange";
import { PasswordDialog } from "../flows/PasswordDialog";
import { PersonalTimezone } from "../flows/PersonalTimezone";
import type { DeletionStatus, SectionResult } from "../port";
import { useWrite } from "../save";
import { SaveError, SaveFooter, SectionBody, SettingRow } from "../SettingsDialog";
import { useDraft, useSection, useSettings } from "../store";

type Account = Extract<SectionResult, { section: "account" }>;

export function AccountSection({ onDeletionRequested }: { onDeletionRequested: (status: DeletionStatus) => void }) {
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
	onDeletionRequested: (status: DeletionStatus) => void;
}) {
	const { draft, setDraft, dirty, settle } = useDraft("account", { name: account.name });
	const [showError, setShowError] = useState(false);
	const write = useWrite("account-name");
	const { port } = useSettings();
	const nameError = !draft.name.trim()
		? "Enter your name."
		: draft.name.trim().length > 200
			? "Use 200 characters or fewer."
			: undefined;

	const save = async () => {
		setShowError(true);
		if (nameError) return;
		const sent = draft;
		const input = { section: "account" as const, name: draft.name.trim() };
		const result = await write.run({ revision: account.revision, input }, (requestKey) =>
			port.saveSection({ requestKey, expectedRevision: account.revision, input }),
		);
		if (result.ok) {
			replace(result.value.current);
			settle(sent);
			setShowError(false);
		}
	};

	return (
		<>
			<SectionBody>
				<SettingRow label="Photo" description="Shown next to your name to people in your church.">
					<AvatarControl account={account} onChanged={(avatar) => replace({ ...account, avatar })} onReload={reload} />
				</SettingRow>
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
				<SettingRow label="Email" description="We send a link to the new address to confirm it.">
					<EmailChange currentEmail={account.email} />
				</SettingRow>
				<SettingRow label="Password" description="Changing it signs out your other devices.">
					<PasswordDialog />
				</SettingRow>
				<SettingRow
					label="Your time zone"
					description="Sets when your own week starts, for things only you see. Your church's time zone is separate."
				>
					<PersonalTimezone />
				</SettingRow>
				<SettingRow
					label="Delete your account"
					description="Deletes your login only. You have 30 days to change your mind."
				>
					<AccountDeletionDialog section={account} onRequested={onDeletionRequested} />
				</SettingRow>
			</SectionBody>
			<SaveFooter
				section="account"
				dirty={dirty}
				saving={write.pending}
				onSave={save}
				error={
					write.refusal ? (
						<SaveError
							message={write.refusal.message}
							reference={write.refusal.reference}
							action={
								write.refusal.code === "conflict" || write.refusal.code === "unknown" ? (
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
