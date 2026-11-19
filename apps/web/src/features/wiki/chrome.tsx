"use client";

import { BookOpen02Icon } from "@hugeicons/core-free-icons";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogHeader,
	IconButton,
	SearchInput,
	Sheet,
	StatePanel,
} from "@everyfield/ui/controls";
import { usePathname } from "next/navigation";
import { createContext, Suspense, use, useMemo, useRef, useState, type ReactNode } from "react";
import { guides } from "./guides.ts";

type Loaded = { status: "ready"; overlays: typeof import("./overlays.tsx") } | { status: "failed" };
type OverlayProps = { open: boolean; onOpenChange: (open: boolean) => void };

const NOT_LOADED: Promise<Loaded> = Promise.resolve({ status: "failed" });
let loading: Promise<Loaded> | null = null;

export function preloadOverlays(): void {
	loading ??= import("./overlays.tsx").then(
		(overlays): Loaded => ({ status: "ready", overlays }),
		(): Loaded => {
			loading = null;
			return { status: "failed" };
		},
	);
}

const loadedOverlays = () => loading ?? NOT_LOADED;

function SearchOverlay(props: OverlayProps) {
	const loaded = use(loadedOverlays());
	return loaded.status === "ready" ? <loaded.overlays.SearchDialog {...props} /> : <SearchUnavailable {...props} />;
}

function GuideOverlay(props: OverlayProps) {
	const loaded = use(loadedOverlays());
	return loaded.status === "ready" ? <loaded.overlays.GuideSheet {...props} /> : <GuideUnavailable {...props} />;
}

function SearchUnavailable({ open, onOpenChange }: OverlayProps) {
	const [typed, setTyped] = useState(false);
	const field = useRef<HTMLInputElement | null>(null);
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				size="lg"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					field.current?.focus();
				}}
			>
				<DialogHeader title="Search the wiki" description="Search titles, excerpts and article text." />
				<DialogBody className="flex flex-col gap-4 pt-1 pb-7 max-app-sm:pb-5">
					<SearchInput
						ref={field}
						maxLength={200}
						placeholder="Search the wiki"
						aria-label="Search words"
						onChange={(event) => setTyped(event.target.value.trim() !== "")}
					/>
					{typed ? (
						<StatePanel tone="error" title="Search could not be loaded" headingLevel="h3">
							This is a loading problem. Try again.
						</StatePanel>
					) : (
						<p className="text-text-2">Type a word to search the wiki.</p>
					)}
				</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

function GuideUnavailable({ open, onOpenChange }: OverlayProps) {
	return (
		<Sheet
			open={open}
			onOpenChange={onOpenChange}
			title="Guide"
			description="A short note for this page."
			modal={false}
		>
			<p>The guide could not be loaded. Try again.</p>
		</Sheet>
	);
}

function Opened({ open, children }: { open: boolean; children: ReactNode }) {
	const [opened, setOpened] = useState(open);
	if (open && !opened) setOpened(true);
	return opened ? children : null;
}

const Chrome = createContext<{ openSearch: () => void; toggleGuide: () => void; guideOpen: boolean } | null>(null);

export function useWikiChrome() {
	return use(Chrome);
}

export function WikiChrome({ children }: { children: ReactNode }) {
	const pathname = usePathname();
	const [searchPath, setSearchPath] = useState<string | null>(null);
	const [guide, setGuide] = useState(false);
	if (searchPath !== null && searchPath !== pathname) setSearchPath(null);
	const chrome = useMemo(
		() => ({
			openSearch: () => {
				preloadOverlays();
				setSearchPath(pathname);
			},
			toggleGuide: () => {
				preloadOverlays();
				if (!guide) guides.refresh(pathname);
				setGuide(!guide);
			},
			guideOpen: guide,
		}),
		[pathname, guide],
	);
	return (
		<Chrome value={chrome}>
			{children}
			<Opened open={searchPath === pathname}>
				<Suspense fallback={null}>
					<SearchOverlay
						open={searchPath === pathname}
						onOpenChange={(next) => setSearchPath(next ? pathname : null)}
					/>
				</Suspense>
			</Opened>
			<Opened open={guide}>
				<Suspense fallback={null}>
					<GuideOverlay open={guide} onOpenChange={setGuide} />
				</Suspense>
			</Opened>
		</Chrome>
	);
}

export function SettingsGuide() {
	const pathname = usePathname();
	const [open, setOpen] = useState(false);
	return (
		<>
			<IconButton
				icon={BookOpen02Icon}
				label="Guide"
				size="sm"
				aria-expanded={open}
				onPointerEnter={preloadOverlays}
				onFocus={preloadOverlays}
				onClick={() => {
					preloadOverlays();
					if (!open) guides.refresh(pathname);
					setOpen(!open);
				}}
			/>
			<Opened open={open}>
				<Suspense fallback={null}>
					<GuideOverlay open={open} onOpenChange={setOpen} />
				</Suspense>
			</Opened>
		</>
	);
}
