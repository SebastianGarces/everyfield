"use client";

import { FONTS, type FontId, type LetterheadKey } from "@everyfield/contracts/branding";
import { Button, ConfirmDialog, Field, Input, Select, Skeleton, Textarea } from "@everyfield/ui/controls";
import { LoadableView, StatusBadge } from "@everyfield/ui/display";
import { useState, type ReactNode } from "react";
import { errorReference } from "../model";
import type { BrandError, BrandView } from "../port";
import { OFFLINE_REFERENCE, type Refusal } from "../save";
import { SaveError, SaveFooter, SectionBody } from "../SettingsDialog";
import { useDraft, useSettings } from "../store";
import { BrandPreview } from "./BrandPreview";
import { familyOf } from "./fonts";
import {
	BADGE_WORDS,
	BRAND_ERROR_TEXT,
	colorOf,
	formOf,
	formatRatio,
	normalizeHex,
	optimisticKit,
	patchOf,
	textColorName,
	themeOf,
	validate,
	type BrandForm,
} from "./model";
import { useBrand } from "./useBrand";

const hex = (digits: string) => `#${digits}`;
/** What the color picker shows while the typed color is empty or not `#RRGGBB`. */
const PICKER_EMPTY = hex("808080");

const FONT_OPTIONS = FONTS.map((font) => ({ value: font.id, label: font.id }));

const LETTERHEAD: { key: LetterheadKey; label: string; hint?: string; placeholder?: string; type?: "textarea" }[] = [
	{ key: "legalName", label: "Legal name", hint: "Shown in the footer of formal documents." },
	{ key: "address", label: "Address", type: "textarea" },
	{ key: "website", label: "Website", placeholder: "https://example.org" },
	{ key: "phone", label: "Phone" },
	{ key: "email", label: "Email" },
	{ key: "ein", label: "EIN", placeholder: "12-3456789" },
	{ key: "tagline", label: "Tagline", hint: "Shown on the cover of outward-facing documents." },
	{ key: "signerName", label: "Signer name" },
	{ key: "signerTitle", label: "Signer title" },
];

const brandRefusal = (error: BrandError): Refusal => ({
	message: BRAND_ERROR_TEXT[error.code],
	reference: errorReference(error),
	code: error.code,
});
/** The reply never arrived, so the save may or may not have been applied. Load latest shows which. */
const OFFLINE: Refusal = {
	message: "Everyfield could not be reached, so this may not have saved. Load the latest version to check.",
	reference: OFFLINE_REFERENCE,
	code: "unknown",
};

export function BrandSection() {
	const { state, setKit, reload } = useBrand();
	return (
		<LoadableView
			state={state}
			empty={{ title: "" }}
			loadingLabel="Loading brand kit"
			skeleton={
				<SectionBody>
					<div className="flex flex-col gap-6 pt-4">
						{[0, 1, 2, 3].map((i) => (
							<Skeleton key={i} shape="block" height={44} />
						))}
					</div>
				</SectionBody>
			}
		>
			{(view) => <BrandEditor view={view} setKit={setKit} reload={reload} />}
		</LoadableView>
	);
}

function BrandEditor({
	view,
	setKit,
	reload,
}: {
	view: BrandView;
	setKit: ReturnType<typeof useBrand>["setKit"];
	reload: () => void;
}) {
	const { port } = useSettings();
	const { kit, churchName } = view;
	const saved = formOf(kit);
	const { draft, setDraft, dirty, saving, refusal, save: runSave } = useDraft<BrandForm>("brand", saved);
	const [showErrors, setShowErrors] = useState(false);
	const [confirmingReset, setConfirmingReset] = useState(false);
	const set = <K extends keyof BrandForm>(key: K, value: BrandForm[K]) => setDraft({ ...draft, [key]: value });

	// Field errors: the contract's rules, plus the field a refusal names. A refusal clears with the next edit.
	const errors = {
		...validate(draft, { required: showErrors }),
		...(refusal?.code === "invalid_ein" ? { ein: BRAND_ERROR_TEXT.invalid_ein } : {}),
		...(refusal?.code === "primary_required" ? { primaryColor: BRAND_ERROR_TEXT.primary_required } : {}),
	};
	const blocked = Object.keys(validate(draft, { required: true })).length > 0;

	// One brand.saveSettings with the expected revision. The screen shows the kit as saved at once; the reply confirms
	// it, or the kit goes back to what the server holds and the refusal says why.
	const save = () => {
		setShowErrors(true);
		if (blocked) return;
		void runSave(async (sent) => {
			const patch = patchOf(sent, saved);
			if (Object.keys(patch).length === 0) return { ok: true, server: saved };
			setKit(optimisticKit(kit, sent));
			const reply = await port.brand.save({ expectedRevision: kit.revision, patch }).catch(() => null);
			// A rollback names the server value it returns to, so the draft is compared with that, not with the
			// optimistic kit that is still on screen for one more render.
			if (reply === null) {
				setKit(kit);
				return { ok: false, refusal: OFFLINE, server: saved };
			}
			if (reply.status === "refused") {
				setKit(kit);
				return { ok: false, refusal: brandRefusal(reply.error), server: saved };
			}
			setKit(reply.value);
			return { ok: true, server: formOf(reply.value) };
		});
	};

	// Reset deletes the kit: the controls show the defaults and every preview tab shows the neutral theme.
	const reset = () =>
		runSave(async () => {
			const reply = await port.brand.reset({ expectedRevision: kit.revision });
			if (reply.status === "refused") return { ok: false, refusal: brandRefusal(reply.error) };
			setKit(reply.value);
			return { ok: true, server: formOf(reply.value) };
		});

	const loadLatest =
		refusal && (refusal.code === "conflict" || refusal.code === "unknown") ? (
			<Button
				size="sm"
				variant="secondary"
				onClick={() => {
					// Reading the kit again clears the refusal; the draft stays, and a change under it rebases.
					setDraft(draft);
					reload();
				}}
			>
				Load latest
			</Button>
		) : undefined;

	const neutral = themeOf(churchName, draft, "formal/legal").kind === "everyfield-neutral";

	return (
		<>
			<SectionBody>
				<div className="@container">
					<div className="grid gap-8 @[680px]:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] @[680px]:items-start">
						<div className="flex min-w-0 flex-col gap-7 pt-4">
							<p className="text-sm text-text-3">
								Brand changes apply only to newly generated documents. Documents you already saved do not change.
							</p>

							<Group title="Colors">
								<ColorField
									label="Primary color"
									value={draft.primaryColor}
									onChange={(v) => set("primaryColor", v)}
									error={errors.primaryColor}
									empty="Required. Your brand color for rules, headings and buttons."
								/>
								<ColorField
									label="Accent color"
									optional
									value={draft.accentColor}
									onChange={(v) => set("accentColor", v)}
									error={errors.accentColor}
									empty="Uses primary color"
								/>
							</Group>

							<Group title="Fonts">
								<FontField label="Heading font" value={draft.headingFont} onChange={(v) => set("headingFont", v)} />
								<FontField label="Body font" value={draft.bodyFont} onChange={(v) => set("bodyFont", v)} />
							</Group>

							<Group title="Letterhead">
								{LETTERHEAD.map(({ key, label, hint, placeholder, type }) => (
									<Field key={key} label={label} optional hint={hint} error={errors[key]}>
										{type === "textarea" ? (
											<Textarea
												rows={2}
												value={draft[key]}
												onChange={(e) => set(key, e.target.value)}
												invalid={Boolean(errors[key])}
											/>
										) : (
											<Input
												value={draft[key]}
												placeholder={placeholder}
												onChange={(e) => set(key, e.target.value)}
												invalid={Boolean(errors[key])}
											/>
										)}
									</Field>
								))}
							</Group>

							{kit.kitState === "saved" ? (
								<div className="flex flex-col items-start gap-2 border-t border-line pt-5">
									<Button variant="secondary" size="sm" onClick={() => setConfirmingReset(true)} disabled={saving}>
										Reset to default
									</Button>
									<p className="text-sm text-text-3">Goes back to the Everyfield-neutral theme.</p>
								</div>
							) : null}
						</div>

						<div className="flex min-w-0 flex-col gap-3 pt-4 @[680px]:sticky @[680px]:top-0">
							<h3 className="font-medium text-ink">Preview</h3>
							<BrandPreview churchName={churchName} form={draft} />
							<p className="text-sm text-text-3" aria-live="polite">
								{neutral
									? "Documents use the Everyfield-neutral theme until a primary color is saved."
									: "This is how new documents will look. It updates as you type."}
							</p>
						</div>
					</div>
				</div>
			</SectionBody>
			<SaveFooter
				section="brand"
				dirty={dirty}
				saving={saving}
				onSave={save}
				error={
					refusal ? (
						<SaveError message={refusal.message} reference={refusal.reference} action={loadLatest} />
					) : showErrors && blocked ? (
						<SaveError message="Some values need a change before you can save. They are marked in red." />
					) : undefined
				}
			/>
			<ConfirmDialog
				open={confirmingReset}
				onOpenChange={setConfirmingReset}
				title="Reset the brand kit?"
				description="New documents will use the Everyfield-neutral theme. Documents you already saved do not change."
				cancelLabel="Keep brand kit"
				confirmLabel="Reset to default"
				tone="danger"
				onConfirm={reset}
			/>
		</>
	);
}

function Group({ title, children }: { title: string; children: ReactNode }) {
	return (
		<section className="flex flex-col gap-4">
			<h3 className="font-medium text-ink">{title}</h3>
			{children}
		</section>
	);
}

function FontField({ label, value, onChange }: { label: string; value: FontId; onChange: (next: FontId) => void }) {
	return (
		<Field label={label}>
			<Select
				options={FONT_OPTIONS}
				value={value}
				onValueChange={(next) => onChange(next as FontId)}
				renderOption={(o) => <span style={{ fontFamily: familyOf(o.value) }}>{o.label}</span>}
			/>
		</Field>
	);
}

/**
 * A color as hex text and a picker that stay in step, with its contrast against white paper: the WCAG ratio, the badge
 * and the text color the documents set on it. The values come from the server's own colorView function.
 */
function ColorField({
	label,
	value,
	onChange,
	error,
	optional,
	empty,
}: {
	label: string;
	value: string;
	onChange: (next: string) => void;
	error: string | undefined;
	optional?: boolean;
	empty: string;
}) {
	const view = colorOf(value);
	return (
		<div className="flex flex-col gap-2">
			<Field label={label} optional={optional} error={error}>
				<div className="flex items-center gap-2.5">
					<input
						type="color"
						aria-label={`${label} picker`}
						value={view ? view.hex.toLowerCase() : PICKER_EMPTY}
						onChange={(e) => onChange(normalizeHex(e.target.value))}
						className="size-11 flex-none cursor-pointer rounded-md border-0 bg-transparent p-0"
					/>
					<Input
						value={value}
						placeholder="#RRGGBB"
						spellCheck={false}
						autoComplete="off"
						onChange={(e) => onChange(normalizeHex(e.target.value))}
						invalid={Boolean(error)}
					/>
				</div>
			</Field>
			{view ? (
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5" data-contrast={view.badge}>
					<span
						aria-hidden="true"
						className="flex size-8 flex-none items-center justify-center rounded-sm text-sm font-semibold"
						style={{ background: view.hex, color: view.textColor }}
					>
						Aa
					</span>
					<span className="num font-medium text-ink">{formatRatio(view.contrast)}</span>
					<StatusBadge
						fill="soft"
						size="sm"
						status={view.badge === "passes_text" ? "positive" : view.badge === "large_text_only" ? "attention" : "risk"}
					>
						{BADGE_WORDS[view.badge]}
					</StatusBadge>
					<span className="text-xs text-text-3">
						{textColorName(view.textColor)} text on this color. Contrast on white.
					</span>
				</div>
			) : (
				<p className="text-sm text-text-3">{empty}</p>
			)}
		</div>
	);
}
