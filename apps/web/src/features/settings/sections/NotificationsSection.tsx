"use client";

import { Mail01Icon } from "@hugeicons/core-free-icons";
import { CalloutLabel, CalloutText, Card, SegmentedControl, Skeleton, Spinner, Switch } from "@everyfield/ui/controls";
import { LoadableView } from "@everyfield/ui/display";
import { useState } from "react";
import { preferenceRows } from "../model";
import type { NotificationChoice, NotificationPatch, SectionResult } from "../port";
import { newRequestKey } from "../port";
import { refusalOf, type Refusal } from "../save";
import { AutoSaveFooter, SaveError, SectionBody } from "../SettingsDialog";
import { useSection, useSettings } from "../store";

type Notifications = Extract<SectionResult, { section: "notifications" }>;

export function NotificationsSection() {
	const { state, replace } = useSection({ section: "notifications" });
	return (
		<>
			<LoadableView
				state={state}
				empty={{ title: "" }}
				loadingLabel="Loading notification choices"
				skeleton={
					<SectionBody>
						<div className="flex flex-col gap-4 pt-4">
							{[0, 1, 2, 3, 4].map((i) => (
								<Skeleton key={i} shape="line" height={36} />
							))}
						</div>
					</SectionBody>
				}
			>
				{(section) => <Preferences section={section} replace={replace} />}
			</LoadableView>
			<AutoSaveFooter />
		</>
	);
}

const pairKey = (c: { category: string; channel: string }) => `${c.category}:${c.channel}`;

/**
 * The category × channel matrix (REQ-IDN-012). Each switch saves at once with the section revision. While it saves
 * the switch shows the new value and a spinner; if the server refuses, the switch returns to the saved value and
 * the reason shows above the table. Only one save runs at a time, so every save carries the latest revision.
 */
function Preferences({ section, replace }: { section: Notifications; replace: (value: SectionResult) => void }) {
	const { port } = useSettings();
	const [pending, setPending] = useState<{ key: string; enabled?: boolean; cadence?: string } | null>(null);
	const [refusal, setRefusal] = useState<{ key: string; refusal: Refusal } | null>(null);
	const values = section.values;
	const rows = preferenceRows(values.choices);

	const save = async (key: string, patch: NotificationPatch, optimistic: { enabled?: boolean; cadence?: string }) => {
		if (pending) return;
		setPending({ key, ...optimistic });
		setRefusal(null);
		try {
			const reply = await port.saveSection({
				requestKey: newRequestKey("notifications"),
				expectedRevision: section.revision,
				input: { section: "notifications", patch },
			});
			if (reply.status === "ok") replace(reply.value.current);
			else setRefusal({ key, refusal: refusalOf(reply.error) });
		} catch {
			setRefusal({
				key,
				refusal: { message: "Your change was not saved. Try again.", reference: "EF-OFFLINE", code: "temporary" },
			});
		} finally {
			setPending(null);
		}
	};

	const toggle = (choice: NotificationChoice) => (enabled: boolean) =>
		save(pairKey(choice), { kind: "channel", choice: { ...choice, enabled } as NotificationChoice }, { enabled });

	const shown = (choice: NotificationChoice) =>
		pending?.key === pairKey(choice) && pending.enabled !== undefined ? pending.enabled : choice.enabled;

	const cell = (choice: NotificationChoice | undefined, label: string, channel: string) =>
		choice ? (
			<span className="inline-flex items-center gap-2">
				<Switch
					checked={shown(choice)}
					onCheckedChange={toggle(choice)}
					disabled={pending !== null && pending.key !== pairKey(choice)}
					aria-label={`${label}, ${channel}`}
					aria-busy={pending?.key === pairKey(choice) || undefined}
				/>
				<span className="inline-grid w-4">
					{pending?.key === pairKey(choice) ? (
						<>
							<Spinner size={14} className="text-text-3" />
							<span className="sr-only" role="status">
								Saving
							</span>
						</>
					) : null}
				</span>
			</span>
		) : (
			<span className="text-text-3">
				<span aria-hidden="true">–</span>
				<span className="sr-only">Not sent by {channel}</span>
			</span>
		);

	const cadence = (kind: "planter_cadence" | "oversight_cadence", value: "daily" | "weekly", label: string) => (
		<div className="mt-2">
			<SegmentedControl
				size="sm"
				label={`${label} frequency`}
				value={pending?.key === kind && pending.cadence ? (pending.cadence as "daily" | "weekly") : value}
				onValueChange={(next) => save(kind, { kind, cadence: next }, { cadence: next })}
				options={[
					{ value: "daily", label: "Daily" },
					{ value: "weekly", label: "Weekly" },
				]}
			/>
		</div>
	);

	return (
		<SectionBody>
			<div aria-live="polite" className="empty:hidden">
				{refusal ? <SaveError message={refusal.refusal.message} reference={refusal.refusal.reference} /> : null}
			</div>
			{rows.length === 0 ? (
				<p className="py-6 text-text-2">Nothing here sends you notifications yet.</p>
			) : (
				<table className="mt-4 w-full border-collapse">
					<caption className="sr-only">Notifications by category and channel</caption>
					<thead>
						<tr className="text-sm text-text-3">
							<th scope="col" className="pb-2.5 text-left font-medium">
								What
							</th>
							<th scope="col" className="w-[120px] pb-2.5 text-center font-medium max-app-sm:w-[84px]">
								In Everyfield
							</th>
							<th scope="col" className="w-[120px] pb-2.5 text-center font-medium max-app-sm:w-[84px]">
								Email
							</th>
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => (
							<tr key={row.category} className="border-t border-line">
								<th scope="row" className="py-3 pr-2 text-left font-normal">
									<span className="block font-medium text-ink">{row.label}</span>
									<span className="block text-sm text-text-3">{row.description}</span>
									{row.category === "planter_digest" && values.planterCadence
										? cadence("planter_cadence", values.planterCadence, row.label)
										: null}
									{row.category === "oversight_digest" && values.oversightCadence
										? cadence("oversight_cadence", values.oversightCadence, row.label)
										: null}
								</th>
								<td className="py-3 text-center">{cell(row.inApp, row.label, "in Everyfield")}</td>
								<td className="py-3 text-center">{cell(row.email, row.label, "email")}</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
			{values.suppression === "suppressed" ? (
				<Card variant="callout" tone="ink" className="mt-6">
					<CalloutLabel tone="ink" icon={Mail01Icon}>
						Email is paused
					</CalloutLabel>
					<CalloutText>
						Emails to your address bounced, so we paused them. You still get updates in Everyfield. Check your email in
						Your account; once the address works again, email can be turned back on.
					</CalloutText>
				</Card>
			) : values.suppression === "unavailable" ? (
				<p className="mt-6 text-sm text-text-3">Email status is not available right now. Your choices still save.</p>
			) : null}
		</SectionBody>
	);
}
