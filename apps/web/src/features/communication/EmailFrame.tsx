"use client";

import { ComputerIcon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { SegmentedControl, Spinner } from "@everyfield/ui/controls";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { renderPreview, type PreviewInput } from "./preview.ts";

// The one place an email shows. The HTML is the exact output of renderPreview, in a sandboxed iframe, so app CSS cannot
// restyle it. The frame is sized to the document height (no inner scrollbar) and scales down, never crops, when the
// space is narrower than the chosen width. Links in it do not navigate. The email stays light in dark mode.

type Width = "desktop" | "phone";
const widthPx: Record<Width, number> = { desktop: 600, phone: 375 };

export function EmailFrame({ html, width, label = "Email preview" }: { html: string; width: Width; label?: string }) {
	const holder = useRef<HTMLDivElement>(null);
	const frame = useRef<HTMLIFrameElement>(null);
	const [available, setAvailable] = useState(widthPx.desktop);
	const [height, setHeight] = useState(240);
	const px = widthPx[width];
	const scale = Math.min(1, available / px);

	useEffect(() => {
		const node = holder.current;
		if (!node) return;
		const watch = new ResizeObserver(() => setAvailable(node.clientWidth));
		watch.observe(node);
		setAvailable(node.clientWidth);
		return () => watch.disconnect();
	}, []);

	const measure = useCallback(() => {
		const doc = frame.current?.contentDocument;
		if (doc?.documentElement) setHeight(Math.max(120, Math.ceil(doc.documentElement.scrollHeight)));
	}, []);

	useEffect(() => measure(), [width, measure]);

	const onLoad = () => {
		const doc = frame.current?.contentDocument;
		if (!doc) return;
		// Links in the email never navigate: the parent cancels the click.
		doc.addEventListener("click", (event) => {
			if ((event.target as Element | null)?.closest?.("a")) event.preventDefault();
		});
		new ResizeObserver(measure).observe(doc.documentElement);
		measure();
	};

	return (
		<div ref={holder} className="w-full min-w-0 overflow-hidden" style={{ height: height * scale }}>
			<iframe
				ref={frame}
				title={label}
				sandbox="allow-same-origin"
				srcDoc={html}
				onLoad={onLoad}
				scrolling="no"
				style={{
					width: px,
					height,
					border: 0,
					display: "block",
					background: "Canvas",
					colorScheme: "light",
					transform: `scale(${scale})`,
					transformOrigin: "top left",
					marginInline: scale < 1 ? 0 : "auto",
				}}
			/>
		</div>
	);
}

export type Chrome = { from: string; to: string; subject: string };

/**
 * The preview stage: a toolbar with the Desktop and Phone switch, app-drawn inbox chrome (From, To, Subject) and the
 * email. It asks renderPreview for the HTML whenever the input changes.
 */
export function PreviewStage({
	input,
	chrome,
	toolbar,
	empty = "Write a message to see it here.",
}: {
	input: PreviewInput;
	chrome: Chrome;
	/** Extra toolbar controls, such as the recipient switcher. */
	toolbar?: ReactNode;
	empty?: string;
}) {
	const [width, setWidth] = useState<Width>("desktop");
	const { bodyHtml, name, hasMeeting, origin, churchName } = input;
	// One render per 300 ms pause in typing. Rendering itself is pure and runs in the browser.
	const [settled, setSettled] = useState(input);
	useEffect(() => {
		const timer = setTimeout(() => setSettled({ bodyHtml, name, hasMeeting, origin, churchName }), 300);
		return () => clearTimeout(timer);
	}, [bodyHtml, name, hasMeeting, origin, churchName]);
	const blank = !bodyHtml.trim();
	const pending = !blank && settled.bodyHtml !== bodyHtml;
	const state = blank ? null : renderPreview(settled);

	return (
		<section aria-label="Email preview" className="flex min-w-0 flex-col gap-3 rounded-lg bg-surface p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<SegmentedControl
					label="Preview width"
					size="sm"
					value={width}
					onValueChange={setWidth}
					options={[
						{ value: "desktop", label: "Desktop", icon: ComputerIcon },
						{ value: "phone", label: "Phone", icon: SmartPhone01Icon },
					]}
				/>
				<div className="flex items-center gap-3">
					{pending ? <Spinner size={14} /> : null}
					{toolbar}
				</div>
			</div>
			<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md bg-surface-raised px-4 py-3 text-sm shadow-[0_0_0_1px_var(--ef-line)]">
				<dt className="text-text-3">From</dt>
				<dd className="truncate text-ink">{chrome.from}</dd>
				<dt className="text-text-3">To</dt>
				<dd className="truncate text-ink">{chrome.to}</dd>
				<dt className="text-text-3">Subject</dt>
				<dd className="truncate font-medium text-ink">{chrome.subject || "No subject yet"}</dd>
			</dl>
			<div className="min-h-[360px] rounded-md bg-surface-2 p-4" aria-live="polite">
				{state && "html" in state ? (
					<EmailFrame html={state.html} width={width} />
				) : state ? (
					<p role="alert" className="text-sm font-medium text-magenta-600">
						{state.error}
					</p>
				) : (
					<p className="text-md text-text-3">{empty}</p>
				)}
			</div>
		</section>
	);
}
