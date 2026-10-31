"use client";

import type { AssetSlot, HexColor } from "@everyfield/contracts/branding";
import { Button, ConfirmDialog, Field, Input } from "@everyfield/ui/controls";
import { useRef, useState } from "react";
import type { BrandKit, BrandPort, SuggestedColors } from "../port";
import { ACCEPT, SLOT_INFO, SLOT_ORDER, backgrounds, canSuggest } from "./assets";
import type { Note, Pick } from "./picks";
import type { useAssets } from "./useAssets";

type Assets = ReturnType<typeof useAssets>;

/**
 * "Logos and images" (REQ-BRD-002): six slots, each with its guidance and either the stored image with its alt text,
 * the picked file waiting for its description, or an empty state. A logo shows on a light, a dark and a brand color
 * background. The brand swatch follows the draft primary color without a request.
 */
export function AssetsGroup({
	kit,
	port,
	assets,
	primary,
	neutralInk,
	accent,
	onUsePrimary,
	onUseAccent,
}: {
	kit: BrandKit;
	port: BrandPort;
	assets: Assets;
	/** The draft primary color when it is a valid `#RRGGBB`. */
	primary: HexColor | null;
	neutralInk: string;
	/** The draft accent color as typed. */
	accent: string;
	onUsePrimary: (color: string) => void;
	onUseAccent: (color: string) => void;
}) {
	const [removing, setRemoving] = useState<AssetSlot | null>(null);
	return (
		<section className="flex flex-col gap-4" aria-labelledby="brand-assets">
			<h3 id="brand-assets" className="font-medium text-ink">
				Logos and images
			</h3>
			<p className="text-sm text-text-3">
				Uploading or removing an image saves it at once. Your other brand changes still need Save.
			</p>
			{assets.suggestion ? (
				<Suggestion
					suggestion={assets.suggestion}
					accent={accent}
					primary={primary}
					onUsePrimary={onUsePrimary}
					onUseAccent={onUseAccent}
					onDismiss={assets.dismissSuggestion}
				/>
			) : null}
			<ul className="flex flex-col gap-4">
				{SLOT_ORDER.map((slot) => (
					<li key={slot}>
						<Slot
							slot={slot}
							kit={kit}
							port={port}
							assets={assets}
							primary={primary}
							neutralInk={neutralInk}
							onRemove={() => setRemoving(slot)}
						/>
					</li>
				))}
			</ul>
			<ConfirmDialog
				open={removing !== null}
				onOpenChange={(open) => !open && setRemoving(null)}
				title={removing ? `Remove the ${SLOT_INFO[removing].label.toLowerCase()}?` : "Remove this image?"}
				description="Documents you generate next use the church name in type in its place. Documents you already saved do not change."
				cancelLabel="Keep image"
				confirmLabel="Remove image"
				tone="danger"
				onConfirm={() => {
					if (removing) void assets.remove(removing);
					setRemoving(null);
				}}
			/>
		</section>
	);
}

function Slot({
	slot,
	kit,
	port,
	assets,
	primary,
	neutralInk,
	onRemove,
}: {
	slot: AssetSlot;
	kit: BrandKit;
	port: BrandPort;
	assets: Assets;
	primary: HexColor | null;
	neutralInk: string;
	onRemove: () => void;
}) {
	const info = SLOT_INFO[slot];
	const stored = kit.assets[slot];
	const pick = assets.picks[slot];
	const note = assets.notes[slot];
	const input = useRef<HTMLInputElement>(null);
	const busy = pick?.status === "uploading";
	return (
		<div data-slot-name={slot} className="flex flex-col gap-3 rounded-md border border-line p-3.5">
			<div className="flex flex-col gap-0.5">
				<span className="font-medium text-ink">{info.label}</span>
				<span className="text-sm text-text-3">{info.guidance}</span>
			</div>

			{pick ? (
				<PickedFile slot={slot} pick={pick} assets={assets} label={info.label} />
			) : stored ? (
				<>
					<div className="flex flex-wrap items-start gap-3">
						<ImageBox src={port.assetSrc(stored.fileId)} alt={stored.alt} dark={info.dark} />
						<p className="min-w-0 flex-1 text-sm text-text-3">
							<span className="font-medium text-ink">Alt text: </span>
							{stored.alt}
						</p>
					</div>
					{info.logo ? (
						<Backgrounds
							src={port.assetSrc(stored.fileId)}
							alt={stored.alt}
							primary={primary}
							neutralInk={neutralInk}
						/>
					) : null}
				</>
			) : (
				<div className="flex h-20 items-center justify-center rounded-sm border border-dashed border-line-strong bg-surface-sunken px-3 text-center text-sm text-text-3">
					No {info.label.toLowerCase()} yet. The church name in type is used.
				</div>
			)}

			{note ? <NoteLine note={note} onLoadLatest={assets.loadLatest} /> : null}

			<div className="flex flex-wrap items-center gap-2">
				{!busy ? (
					<Button size="sm" variant="secondary" onClick={() => input.current?.click()}>
						{pick ? "Choose another file" : stored ? "Replace" : "Choose file"}
					</Button>
				) : null}
				{!pick && stored ? (
					<Button size="sm" variant="ghost" onClick={onRemove}>
						Remove
					</Button>
				) : null}
				{!pick && stored && canSuggest(slot) ? (
					<Button size="sm" variant="ghost" onClick={() => void assets.suggest(slot)}>
						Suggest colors
					</Button>
				) : null}
				<input
					ref={input}
					type="file"
					accept={ACCEPT}
					aria-label={`${info.label} file`}
					className="sr-only"
					tabIndex={-1}
					onChange={(e) => {
						const file = e.target.files?.[0];
						if (file) assets.choose(slot, file);
						e.target.value = "";
					}}
				/>
			</div>
		</div>
	);
}

function PickedFile({ slot, pick, assets, label }: { slot: AssetSlot; pick: Pick; assets: Assets; label: string }) {
	const busy = pick.status === "uploading";
	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap items-start gap-3">
				<ImageBox src={pick.url} alt="" dark={SLOT_INFO[slot].dark} busy={busy} />
				<p className="min-w-0 flex-1 text-sm text-text-3" aria-live="polite">
					<span className="font-medium text-ink break-all">{pick.name}</span>
					<br />
					{busy ? "Uploading…" : "Add a description, then upload."}
				</p>
			</div>
			<Field
				label={`${label} description`}
				hint="Read aloud by screen readers and shown if the image does not load."
				error={pick.altError}
			>
				<Input
					value={pick.alt}
					disabled={busy}
					maxLength={300}
					invalid={Boolean(pick.altError)}
					onChange={(e) => assets.setAlt(slot, e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							void assets.confirm(slot);
						}
					}}
				/>
			</Field>
			<div className="flex flex-wrap gap-2">
				<Button size="sm" variant="primary" loading={busy} onClick={() => void assets.confirm(slot)}>
					Upload
				</Button>
				<Button size="sm" variant="ghost" disabled={busy} onClick={() => assets.cancel(slot)}>
					Cancel
				</Button>
			</div>
		</div>
	);
}

function ImageBox({ src, alt, dark, busy }: { src: string; alt: string; dark: boolean; busy?: boolean }) {
	return (
		<div
			className="flex h-20 w-40 flex-none items-center justify-center overflow-hidden rounded-sm border border-line p-2"
			style={{ background: dark ? "var(--color-ink-fixed)" : "white", opacity: busy ? 0.6 : 1 }}
		>
			{/* eslint-disable-next-line @next/next/no-img-element -- the authenticated route or a local object URL */}
			<img src={src} alt={alt} className="max-h-full max-w-full object-contain" />
		</div>
	);
}

function Backgrounds({
	src,
	alt,
	primary,
	neutralInk,
}: {
	src: string;
	alt: string;
	primary: HexColor | null;
	neutralInk: string;
}) {
	const swatches = backgrounds(primary, neutralInk);
	const note = swatches.find((s) => s.note)?.note;
	return (
		<div className="flex flex-col gap-1.5">
			<div className="grid grid-cols-3 gap-2" data-backgrounds>
				{swatches.map((s) => (
					<div key={s.name} className="flex flex-col gap-1">
						<div
							data-background={s.name.toLowerCase()}
							className="flex h-14 items-center justify-center overflow-hidden rounded-sm border border-line p-2"
							style={{ background: s.color }}
						>
							{/* eslint-disable-next-line @next/next/no-img-element -- the authenticated route */}
							<img src={src} alt={s.name === "Light" ? alt : ""} className="max-h-full max-w-full object-contain" />
						</div>
						<span className="text-xs text-text-3">{s.name}</span>
					</div>
				))}
			</div>
			{note ? <p className="text-xs text-text-3">{note}</p> : null}
		</div>
	);
}

function NoteLine({ note, onLoadLatest }: { note: Note; onLoadLatest: () => void }) {
	return (
		<div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-magenta-600">
			<span>
				{note.message}
				{note.reference ? ` Reference ${note.reference}.` : ""}
			</span>
			{note.conflict ? (
				<Button size="sm" variant="secondary" onClick={onLoadLatest}>
					Load latest
				</Button>
			) : null}
		</div>
	);
}

function Suggestion({
	suggestion,
	primary,
	accent,
	onUsePrimary,
	onUseAccent,
	onDismiss,
}: {
	suggestion: SuggestedColors;
	primary: HexColor | null;
	accent: string;
	onUsePrimary: (color: string) => void;
	onUseAccent: (color: string) => void;
	onDismiss: () => void;
}) {
	return (
		<div
			data-suggestion
			className="flex flex-col gap-3 rounded-md border border-line bg-surface-sunken p-3.5"
			role="region"
			aria-label="Suggested colors"
		>
			<p className="text-sm text-ink">
				Colors from your {SLOT_INFO[suggestion.suggestedFrom].label.toLowerCase()}. Nothing changes until you choose.
			</p>
			<div className="flex flex-wrap items-end gap-x-5 gap-y-3">
				<div className="flex flex-col gap-1">
					<span className="text-xs text-text-3">Suggested primary</span>
					<Swatch color={suggestion.suggestedPrimary} label="Suggested primary" />
				</div>
				<div className="flex flex-col gap-1">
					<span className="text-xs text-text-3">Palette</span>
					<div className="flex flex-wrap gap-2">
						{suggestion.palette.map((color) => (
							<Swatch
								key={color}
								color={color}
								label={`Use ${color} as the accent color`}
								selected={accent.toUpperCase() === color}
								onClick={() => onUseAccent(color)}
							/>
						))}
					</div>
				</div>
			</div>
			<p className="text-xs text-text-3">Choose a palette color to use it as the accent color.</p>
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					variant="primary"
					disabled={primary === suggestion.suggestedPrimary}
					onClick={() => onUsePrimary(suggestion.suggestedPrimary)}
				>
					Use suggested colors
				</Button>
				<Button size="sm" variant="ghost" onClick={onDismiss}>
					Dismiss
				</Button>
			</div>
		</div>
	);
}

function Swatch({
	color,
	label,
	selected,
	onClick,
}: {
	color: string;
	label: string;
	selected?: boolean;
	onClick?: () => void;
}) {
	const base = "flex size-9 flex-none rounded-sm border";
	if (!onClick)
		return (
			<span
				role="img"
				aria-label={`${label} ${color}`}
				className={`${base} border-line`}
				style={{ background: color }}
				title={color}
			/>
		);
	return (
		<button
			type="button"
			aria-label={label}
			aria-pressed={selected}
			title={color}
			onClick={onClick}
			className={`${base} cursor-pointer ${selected ? "border-ink ring-2 ring-ink" : "border-line"}`}
			style={{ background: color }}
		/>
	);
}
