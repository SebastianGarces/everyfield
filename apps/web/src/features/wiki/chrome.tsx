"use client";

import { BookOpen02Icon } from "@hugeicons/core-free-icons";
import { IconButton } from "@everyfield/ui/controls";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { createContext, use, useMemo, useState, type ReactNode } from "react";
import { guides } from "./guides.ts";

const SearchDialog = dynamic(() => import("./overlays.tsx").then((m) => m.SearchDialog));
const GuideSheet = dynamic(() => import("./overlays.tsx").then((m) => m.GuideSheet));

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
			openSearch: () => setSearchPath(pathname),
			toggleGuide: () => {
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
				<SearchDialog open={searchPath === pathname} onOpenChange={(next) => setSearchPath(next ? pathname : null)} />
			</Opened>
			<Opened open={guide}>
				<GuideSheet open={guide} onOpenChange={setGuide} />
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
				onClick={() => {
					if (!open) guides.refresh(pathname);
					setOpen(!open);
				}}
			/>
			<Opened open={open}>
				<GuideSheet open={open} onOpenChange={setOpen} />
			</Opened>
		</>
	);
}
