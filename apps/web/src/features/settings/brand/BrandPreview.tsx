"use client";

import type { DocumentClass, DocumentTheme } from "@everyfield/contracts/branding";
import { textOn } from "@everyfield/domain/branding/color";
import { Tab, Tabs, TabsList, TabsPanel } from "@everyfield/ui/controls";
import { useState, type CSSProperties, type ReactNode } from "react";
import { familyOf } from "./fonts";
import { themeOf, type BrandForm } from "./model";

// The live preview (REQ-BRD-006, REQ-DOC-017): one miniature page per document class. Every rule on it comes from the
// theme that resolveDocumentTheme returns for the unsaved draft, the function the server resolves with, so no class
// rule is written here. Text uses theme.colors.ink or theme.colors.heading only; a brand color appears as a rule or a
// fill, with the derived text color (textOn) on the fill. Logos are fixed-size slots with the church name in type.

const CLASSES: { value: DocumentClass; label: string }[] = [
	{ value: "formal/legal", label: "Formal/legal" },
	{ value: "outward-facing", label: "Outward-facing" },
	{ value: "operational", label: "Operational" },
	{ value: "email", label: "Email" },
];

/** The sheet is drawn at this many pixels per millimetre of the printed page, so a slot keeps its real proportions. */
const PX_PER_MM = 1.7;
const PAPER = "white";

export function BrandPreview({ churchName, form }: { churchName: string; form: BrandForm }) {
	const [tab, setTab] = useState<DocumentClass>("formal/legal");
	return (
		<Tabs value={tab} onValueChange={(next) => setTab(next as DocumentClass)}>
			<TabsList aria-label="Document class" className="gap-5! max-app-sm:gap-4!">
				{CLASSES.map((c) => (
					<Tab key={c.value} value={c.value} className="text-[14px]!">
						{c.label}
					</Tab>
				))}
			</TabsList>
			{CLASSES.map((c) => (
				<TabsPanel key={c.value} value={c.value} className="pt-4">
					<Sheet theme={themeOf(churchName, form, c.value)} />
				</TabsPanel>
			))}
		</Tabs>
	);
}

function Sheet({ theme }: { theme: DocumentTheme }) {
	const { layout } = theme;
	const style: CSSProperties = {
		background: PAPER,
		color: theme.colors.ink,
		fontFamily: familyOf(theme.fonts.body),
	};
	return (
		<div
			data-theme-kind={theme.kind}
			data-class={layout.documentClass}
			className="overflow-hidden rounded-md border border-line shadow-raised"
			style={style}
		>
			{layout.documentClass === "formal/legal" ? <Formal theme={theme} layout={layout} /> : null}
			{layout.documentClass === "outward-facing" ? <Outward theme={theme} layout={layout} /> : null}
			{layout.documentClass === "operational" ? <Operational theme={theme} layout={layout} /> : null}
			{layout.documentClass === "email" ? <Email theme={theme} layout={layout} /> : null}
		</div>
	);
}

type Layout<C extends DocumentClass> = Extract<DocumentTheme["layout"], { documentClass: C }>;

const heading = (theme: DocumentTheme): CSSProperties => ({
	fontFamily: familyOf(theme.fonts.heading),
	color: theme.colors.heading,
	fontWeight: 400,
});

/**
 * A logo slot: fixed height (and width or max width), the church name set in type. A file the church uploads takes the
 * slot in the next slice. No Everyfield logo is ever drawn.
 */
function LogoSlot({
	theme,
	height,
	width,
	maxWidth,
	size,
}: {
	theme: DocumentTheme;
	height: number;
	width?: number;
	maxWidth?: number;
	size: number;
}) {
	return (
		<div
			data-slot="logo"
			className="flex items-center overflow-hidden"
			style={{ height, width, maxWidth, ...heading(theme), color: theme.colors.ink, fontSize: size, lineHeight: 1.1 }}
		>
			<span className="truncate">{theme.churchName}</span>
		</div>
	);
}

/** Text lines standing for body copy. They are ink at low weight, never a brand color. */
function Lines({ widths }: { widths: number[] }) {
	return (
		<div className="flex flex-col gap-[5px]" aria-hidden="true">
			{widths.map((w, i) => (
				<span
					key={i}
					className="block h-[5px] rounded-pill opacity-20"
					style={{ width: `${w}%`, background: "currentColor" }}
				/>
			))}
		</div>
	);
}

function Formal({ theme, layout }: { theme: DocumentTheme; layout: Layout<"formal/legal"> }) {
	const { footer, signature } = layout;
	return (
		<div className="flex min-h-[420px] flex-col px-6 pt-5 pb-4" style={{ fontSize: 11 }}>
			<LogoSlot theme={theme} height={layout.headerLogoHeightMm * PX_PER_MM} width={150} size={13} />
			<div className="mt-2 h-0.5" style={{ background: theme.colors.rule }} />
			<h4 className="mt-5 text-[19px] leading-tight" style={heading(theme)}>
				Letter of agreement
			</h4>
			<p className="mt-2 leading-snug">
				This letter confirms the terms we discussed for the use of the building each Sunday.
			</p>
			<div className="mt-3">
				<Lines widths={[100, 94, 98, 62]} />
			</div>
			<div className="mt-5">
				<Lines widths={[100, 90, 40]} />
			</div>
			<div className="mt-auto pt-6">
				<p className="text-[10px] opacity-60">Signed</p>
				<p className="mt-4 border-t pt-1 font-medium" style={{ borderColor: theme.colors.ink }}>
					{signature.name ?? "Signer name"}
					<span className="ml-1.5 font-normal opacity-70">{signature.title ?? "Title"}</span>
				</p>
			</div>
			<div className="mt-4 border-t pt-2" style={{ borderColor: theme.colors.rule }}>
				<div className="flex items-baseline justify-between gap-3 text-[10px] opacity-80">
					<span className="min-w-0 truncate">
						{footer.name}
						{footer.address ? ` · ${footer.address}` : ""}
						{footer.ein ? ` · EIN ${footer.ein}` : ""}
					</span>
					<span className="flex-none">Page 1 of 1</span>
				</div>
			</div>
		</div>
	);
}

function Outward({ theme, layout }: { theme: DocumentTheme; layout: Layout<"outward-facing"> }) {
	// The cover band is the primary color, or the neutral rule color in the neutral theme. Text on it is derived.
	const band = theme.colors.rule;
	const stripe = theme.colors.accent ?? theme.colors.rule;
	const { contact } = layout;
	const details = [contact.address, contact.website, contact.phone, contact.email].filter(Boolean);
	return (
		<div className="flex min-h-[420px] flex-col" style={{ fontSize: 11 }}>
			<div className="px-6 pt-5">
				<LogoSlot theme={theme} height={layout.coverLogoHeightMm * PX_PER_MM} width={200} size={20} />
			</div>
			<div className="mt-4 px-6 py-6" style={{ background: band, color: textOn(band) }}>
				<h4
					className="text-[22px] leading-tight"
					style={{ fontFamily: familyOf(theme.fonts.heading), fontWeight: 400 }}
				>
					Welcome to {theme.churchName}
				</h4>
				<p className="mt-1.5">Spring newcomer guide</p>
			</div>
			<div className="h-1.5" style={{ background: stripe }} />
			<div className="flex flex-1 flex-col gap-3 px-6 pt-4 pb-5">
				{layout.tagline ? (
					<p className="text-[14px] leading-snug" style={heading(theme)}>
						{layout.tagline}
					</p>
				) : (
					<Lines widths={[80, 55]} />
				)}
				<Lines widths={[100, 92, 96]} />
				<div className="mt-auto flex flex-col gap-0.5 text-[10px] opacity-80">
					{details.length > 0 ? (
						details.map((d) => <span key={d}>{d}</span>)
					) : (
						<span>Address, website, phone and email</span>
					)}
				</div>
			</div>
		</div>
	);
}

function Operational({ theme, layout }: { theme: DocumentTheme; layout: Layout<"operational"> }) {
	const { tableHeader, checkbox } = layout;
	const rows = ["Set up chairs", "Open the doors", "Welcome table"];
	return (
		<div className="flex min-h-[420px] flex-col px-6 pt-5 pb-4" style={{ fontSize: 11 }}>
			<div className="flex items-center gap-3">
				<LogoSlot theme={theme} height={layout.markHeightMm * PX_PER_MM} width={84} size={9} />
				<h4 className="text-[17px] leading-tight" style={heading(theme)}>
					Sunday checklist
				</h4>
			</div>
			<div className="mt-4 overflow-hidden rounded-xs border border-line">
				<div
					className="grid grid-cols-[1fr_44px] px-2.5 py-1.5 font-medium"
					style={{ background: tableHeader.fill, color: tableHeader.text }}
				>
					<span>Task</span>
					<span>Done</span>
				</div>
				{rows.map((row, i) => (
					<div key={row} className="grid grid-cols-[1fr_44px] items-center border-t border-line px-2.5 py-2">
						<span>{row}</span>
						<span
							data-checkbox={i < 2 ? "checked" : "empty"}
							className="flex size-4 items-center justify-center rounded-xs border text-[10px] leading-none"
							style={
								i < 2
									? { background: checkbox.fill, color: checkbox.text, borderColor: checkbox.fill }
									: { borderColor: checkbox.fill }
							}
						>
							{i < 2 ? "✓" : null}
						</span>
					</div>
				))}
			</div>
			<div className="mt-4">
				<Lines widths={[90, 60]} />
			</div>
		</div>
	);
}

function Email({ theme, layout }: { theme: DocumentTheme; layout: Layout<"email"> }) {
	const { button, footer } = layout;
	return (
		<div className="flex min-h-[420px] flex-col px-6 pt-5 pb-4" style={{ fontSize: 12 }}>
			<LogoSlot theme={theme} height={36} maxWidth={layout.logoMaxWidthPx} size={15} />
			<div className="mt-1 h-px" style={{ background: theme.colors.rule }} />
			<h4 className="mt-5 text-[18px] leading-tight" style={heading(theme)}>
				See you this Sunday
			</h4>
			<p className="mt-2 leading-snug">We meet at ten. Bring a friend, and come early for coffee.</p>
			<div className="mt-4">
				<Lines widths={[100, 88, 52]} />
			</div>
			<ButtonSample fill={button.fill} text={button.text}>
				Plan your visit
			</ButtonSample>
			<div className="mt-auto border-t border-line pt-3 text-[10px] opacity-80">
				<p className="font-medium">{footer.churchName}</p>
				{footer.address ? <p>{footer.address}</p> : null}
			</div>
		</div>
	);
}

function ButtonSample({ fill, text, children }: { fill: string; text: string; children: ReactNode }) {
	return (
		<span
			data-email-button=""
			className="mt-5 inline-flex h-9 w-fit items-center rounded-sm px-4 font-medium"
			style={{ background: fill, color: text }}
		>
			{children}
		</span>
	);
}
