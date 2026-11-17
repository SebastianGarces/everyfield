import Link from "next/link";
import type { ReactNode } from "react";
import { Display } from "@/components/Display";
import { Logo, LogoSymbols } from "@/components/Logo";

export function RootState({ title, children, actions }: { title: string; children: ReactNode; actions: ReactNode }) {
	return (
		<div className="flex min-h-dvh flex-col px-page">
			<LogoSymbols />
			<header className="mx-auto flex w-full max-w-mk items-center py-6">
				<Link href="/" className="rounded-md">
					<Logo variant="nav" />
				</Link>
			</header>
			<main
				id="view"
				tabIndex={-1}
				className="mx-auto flex w-full max-w-[36rem] flex-1 flex-col items-center justify-center pb-[12vh] text-center focus:outline-none"
			>
				<Display as="h1" size="h1">
					{title}
				</Display>
				<p className="mt-5 max-w-[44ch] type-lg text-text-2 text-pretty">{children}</p>
				<div className="mt-9 flex flex-wrap justify-center gap-3">{actions}</div>
			</main>
		</div>
	);
}
