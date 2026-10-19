import type { ReactNode } from "react";
import { Display } from "@/components/Display";
import { COPY, type LegalCopy } from "./copy";
import { PageHero } from "./sections/PageHero";
import { Site } from "./Site";

const LINK = "text-green-600 underline";

/** Plain copy text with links: e-mail addresses become mailto links, and `privacyWords` links to /privacy. */
function linked(text: string, privacyWords?: string): ReactNode[] {
	const pattern = new RegExp(
		"([^\\s@]+@[^\\s@]+\\.[a-z]{2,})" +
			(privacyWords ? "|(" + privacyWords.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")" : ""),
		"i",
	);
	const out: ReactNode[] = [];
	let rest = text,
		key = 0;
	for (let m = rest.match(pattern); m && m.index !== undefined; m = rest.match(pattern)) {
		out.push(rest.slice(0, m.index));
		if (m[1]) {
			const addr = m[1].replace(/[.,;:]+$/, "");
			out.push(
				<a key={key++} href={"mailto:" + addr} className={LINK}>
					{addr}
				</a>,
				m[1].slice(addr.length),
			);
		} else
			out.push(
				<a key={key++} href="/privacy" className={LINK}>
					{m[0]}
				</a>,
			);
		rest = rest.slice(m.index + m[0].length);
	}
	out.push(rest);
	return out;
}

/** The privacy and terms pages, rendered from shared.privacy_page / shared.terms_page (task E2). */
export function Legal({ path, copy }: { path: string; copy: LegalCopy }) {
	const privacy = copy.links?.privacy;
	return (
		<Site path={path}>
			<PageHero title={copy.title}>
				<div className="mx-auto mt-9 grid max-w-[72ch] gap-[18px] text-left text-text-2">
					{copy.updated ? <p className="type-md text-text-3">{copy.updated}</p> : null}
					{copy.intro?.map((p, i) => (
						<p key={i}>{linked(p, privacy)}</p>
					))}
					{copy.sections.map((s) => (
						<section key={s.heading} className="mt-4 grid gap-3">
							<Display as="h2" size="h3" className="text-ink">
								{s.heading}
							</Display>
							{s.paragraphs?.map((p, i) => (
								<p key={i}>{linked(p, privacy)}</p>
							))}
							{s.items?.length ? (
								<ul className="grid list-disc gap-2 pl-5">
									{s.items.map((it, i) => (
										<li key={i}>{linked(it, privacy)}</li>
									))}
								</ul>
							) : null}
						</section>
					))}
					<p>{COPY.shared.footer.fineprint}</p>
				</div>
			</PageHero>
		</Site>
	);
}
