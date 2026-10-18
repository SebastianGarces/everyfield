import { cn, LogoMark, Wordmark } from "@everyfield/ui/foundations";
import Link from "next/link";
import type { ReactNode } from "react";

// The prototype's film grain (.auth-brand::before). The SVG has no color of its own; saturate 0 makes it grey noise.
const GRAIN =
	"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='3'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

/**
 * The bare sign-in layout from the prototype (#/signin, .auth): the brand panel on the left and the form column on the
 * right, with no top bar or rail. The brand panel keeps its fixed ink and cream in both themes, as printed brand
 * material does. Below 1024px it becomes a short band above the form (not drawn; see the task rulings).
 */
export function AuthFrame({ children }: { children: ReactNode }) {
	return (
		<div className="grid min-h-dvh grid-cols-2 max-app-md:grid-cols-1 max-app-md:grid-rows-[auto_1fr]">
			<aside
				aria-label="Everyfield"
				className="relative m-4 mr-0 flex flex-col overflow-hidden rounded-[30px] bg-ink-fixed px-[52px] py-11 text-cream max-app-md:m-3 max-app-md:rounded-[24px] max-app-md:px-6 max-app-md:py-6"
			>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 opacity-[0.14] mix-blend-overlay"
					style={{ backgroundImage: GRAIN }}
				/>
				<Link
					href="/"
					className="relative z-10 flex w-fit items-center gap-3 rounded-sm text-cream focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-cream"
				>
					<LogoMark className="w-[34px] max-app-sm:w-7" />
					<Wordmark className="h-6 max-app-sm:h-5" />
					<span className="sr-only">Everyfield home</span>
				</Link>
				<div className="relative z-10 mt-[110px] max-app-md:mt-8 max-app-md:max-w-[70%] max-app-sm:mt-6">
					<p className="font-display text-[44px] leading-[1.08] tracking-[-0.03em] text-balance max-app-md:text-[30px] max-app-sm:text-[26px]">
						Gather your people.
						<br />
						Plant your church.
					</p>
					<p className="mt-4 max-w-[420px] text-cream/72 max-app-sm:hidden">
						The Launch Playbook, your people, meetings and ministries in one place.
					</p>
				</div>
				<LogoMark className="pointer-events-none absolute -right-[110px] -bottom-[90px] w-[460px] text-green-500 opacity-95 max-app-md:-right-16 max-app-md:-bottom-16 max-app-md:w-[220px] max-app-sm:w-[170px]" />
			</aside>
			<main id="main" className="grid place-items-center p-10 max-app-md:px-5 max-app-md:pt-6 max-app-md:pb-12">
				<div className="w-full max-w-[400px]">{children}</div>
			</main>
		</div>
	);
}

/** The screen heading and its lead sentence, as drawn: a 34px display heading over muted text. */
export function AuthHeading({ title, children }: { title: string; children?: ReactNode }) {
	return (
		<header>
			<h1 className="text-[34px] leading-[1.1] text-balance text-ink max-app-sm:text-[30px]">{title}</h1>
			{children ? <p className="mt-2 text-text-2 text-pretty">{children}</p> : null}
		</header>
	);
}

/** The centered line under a form ("New to Everyfield? Start your church"). */
export function AuthFooter({ children }: { children: ReactNode }) {
	return <p className="mt-6 text-center text-sm text-text-2">{children}</p>;
}

/** An inline text link in the ink color, underlined on hover, with the product focus ring. */
export function AuthLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
	return (
		<Link
			href={href}
			className={cn("rounded-[4px] font-semibold text-ink underline-offset-4 hover:underline", className)}
		>
			{children}
		</Link>
	);
}
