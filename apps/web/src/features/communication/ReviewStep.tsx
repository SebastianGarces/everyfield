"use client";

import { ArrowDown01Icon, ArrowLeft01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Field,
	IconButton,
	Input,
	Menu,
	MenuContent,
	MenuItem,
	MenuSeparator,
	MenuTrigger,
	Select,
} from "@everyfield/ui/controls";
import { useMemo, useState } from "react";
import { PreviewStage } from "./EmailFrame.tsx";
import { textToBody } from "./body.ts";
import { listed, plural, type Form } from "./composeModel.ts";
import { groupLabel, type AudienceSummary, type MeetingContext, type Team, type Template } from "./model.ts";

// Review and send: the full-width email with a "Preview as" switcher, and the "Ready to send?" panel.

const WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

const pad = (n: number) => String(n).padStart(2, "0");
const localStamp = (d: Date) =>
	`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Tomorrow at 9:00 and the next Sunday at 8:00, both local, both inside the window. */
export function presets(now = new Date()): { label: string; at: Date }[] {
	const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0);
	const toSunday = ((7 - now.getDay()) % 7) || 7;
	const sunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + toSunday, 8, 0);
	return [
		{ label: "Tomorrow, 9:00 AM", at: tomorrow },
		{ label: "Sunday, 8:00 AM", at: sunday },
	];
}

export type SendPlan = { kind: "now" } | { kind: "at"; at: Date };

export function ReviewStep({
	form,
	templates,
	teams,
	summary,
	meeting,
	churchName,
	origin,
	sampleName,
	canSend,
	busy,
	onPlan,
	onSaveDraft,
	onBack,
}: {
	form: Form;
	templates: Template[];
	teams: Team[];
	summary: AudienceSummary | null;
	meeting: MeetingContext | null;
	churchName: string;
	origin: string;
	sampleName: string;
	canSend: boolean;
	busy: boolean;
	onPlan: (plan: SendPlan) => void;
	onSaveDraft: () => void;
	onBack: () => void;
}) {
	const recipients = summary?.recipients ?? [];
	const [index, setIndex] = useState(0);
	const [picking, setPicking] = useState(false);
	const [custom, setCustom] = useState("");
	const [customError, setCustomError] = useState<string | undefined>();
	const bounds = useMemo(() => {
		const now = new Date();
		return { min: localStamp(now), max: localStamp(new Date(now.getTime() + WINDOW_MS)) };
	}, []);
	const safe = Math.min(index, Math.max(0, recipients.length - 1));
	const name = recipients[safe]?.displayName ?? sampleName;
	const eligible = summary?.eligibleRecipients ?? 0;
	const template = templates.find((t) => t.templateId === form.templateKey);
	const chosen = [
		...form.audience.groups.map((g) => groupLabel[g as keyof typeof groupLabel] ?? g),
		...form.audience.teamIds.map((id) => teams.find((t) => t.id === id)?.name ?? "A team"),
		...form.people.map((p) => p.displayName),
	];
	const left = summary?.missingEmailExclusions ?? [];

	const schedulePicked = () => {
		const at = custom ? new Date(custom) : null;
		if (!at || Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60_000 || at.getTime() > Date.now() + WINDOW_MS) {
			setCustomError("Choose a send time from now through the next 30 days.");
			return;
		}
		setCustomError(undefined);
		onPlan({ kind: "at", at });
	};

	return (
		<div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
			<PreviewStage
				input={{ bodyHtml: textHtml(form), name, hasMeeting: form.meetingId !== null, origin }}
				chrome={{ from: churchName, to: name, subject: form.subject }}
				toolbar={
					<div className="flex items-center gap-2">
						<div className="w-56">
							<Select
								aria-label="Preview as"
								value={String(safe)}
								onValueChange={(value) => setIndex(Number(value))}
								options={
									recipients.length > 0
										? recipients.map((r, i) => ({ value: String(i), label: r.displayName }))
										: [{ value: "0", label: `${sampleName} (sample)` }]
								}
							/>
						</div>
						<IconButton
							icon={ArrowLeft01Icon}
							label="Previous recipient"
							disabled={safe <= 0}
							onClick={() => setIndex(safe - 1)}
						/>
						<span aria-live="polite" className="text-sm text-text-2 tabular-nums">
							{recipients.length === 0 ? "0 of 0" : `${safe + 1} of ${recipients.length}`}
						</span>
						<IconButton
							icon={ArrowRight01Icon}
							label="Next recipient"
							disabled={safe >= recipients.length - 1}
							onClick={() => setIndex(safe + 1)}
						/>
					</div>
				}
			/>
			<aside aria-label="Ready to send?" className="flex flex-col gap-5 rounded-lg bg-surface p-5">
				<h2 className="font-title text-title-md leading-[1.2] tracking-[-0.02em] text-ink">Ready to send?</h2>
				<dl className="flex flex-col gap-3 text-md">
					<Row label="From" value={churchName} />
					<Row label="To" value={`${plural(eligible, "person", "people")}${chosen.length ? ` · ${listed(chosen)}` : ""}`} />
					<Row
						label="Left out"
						value={left.length === 0 ? "No one" : left.map((n) => `${n}, no email address`).join("; ")}
					/>
					<Row label="Subject" value={form.subject} />
					<Row label="Template" value={template?.name ?? "None"} />
					<Row label="Meeting" value={meeting ? `${meeting.title}` : "None"} />
				</dl>
				{!canSend ? (
					<p className="text-sm text-text-2">Choose at least one person who can get email before you send.</p>
				) : null}
				<div className="flex">
					<Button
						variant="primary"
						className="flex-1 rounded-r-none"
						disabled={!canSend || busy}
						onClick={() => onPlan({ kind: "now" })}
					>
						{`Send now to ${eligible}`}
					</Button>
					<Menu>
						<MenuTrigger asChild>
							<Button
								variant="primary"
								icon={ArrowDown01Icon}
								aria-label="More ways to send"
								className="rounded-l-none border-l border-on-ink/30"
								disabled={busy}
							/>
						</MenuTrigger>
						<MenuContent align="end">
							{presets().map((preset) => (
								<MenuItem key={preset.label} disabled={!canSend} onSelect={() => onPlan({ kind: "at", at: preset.at })}>
									{`Schedule: ${preset.label}`}
								</MenuItem>
							))}
							<MenuItem disabled={!canSend} onSelect={() => setPicking(true)}>
								Schedule: pick a date and time
							</MenuItem>
							<MenuSeparator />
							<MenuItem onSelect={onSaveDraft}>Save draft</MenuItem>
							<MenuItem onSelect={onBack}>Back to Write</MenuItem>
						</MenuContent>
					</Menu>
				</div>
				{picking ? (
					<div className="flex flex-col gap-3">
						<Field label="Send time" hint="From now through the next 30 days." error={customError}>
							<Input
								type="datetime-local"
								value={custom}
								min={bounds.min}
								max={bounds.max}
								suppressHydrationWarning
								onChange={(event) => {
									setCustom(event.target.value);
									setCustomError(undefined);
								}}
							/>
						</Field>
						<Button variant="secondary" onClick={schedulePicked} disabled={!canSend || busy}>
							Schedule
						</Button>
					</div>
				) : null}
				<p className="text-xs text-text-3">Scheduling does not send the email.</p>
			</aside>
		</div>
	);
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="grid grid-cols-[84px_minmax(0,1fr)] gap-3">
			<dt className="text-sm text-text-3">{label}</dt>
			<dd className="min-w-0 break-words text-ink">{value}</dd>
		</div>
	);
}

const textHtml = (form: Form): string => textToBody(form.text);
