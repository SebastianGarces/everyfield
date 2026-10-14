import type { ReactNode } from "react";
import { COPY, type LegalCopy } from "./copy";
import { Site } from "./Site";

/** Plain copy text with links: e-mail addresses become mailto links, and `privacyWords` links to /privacy. */
function linked(text: string, privacyWords?: string): ReactNode[] {
  const pattern = new RegExp("([^\\s@]+@[^\\s@]+\\.[a-z]{2,})" + (privacyWords ? "|(" + privacyWords.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")" : ""), "i");
  const out: ReactNode[] = [];
  let rest = text, key = 0;
  for (let m = rest.match(pattern); m && m.index !== undefined; m = rest.match(pattern)) {
    out.push(rest.slice(0, m.index));
    if (m[1]) {
      const addr = m[1].replace(/[.,;:]+$/, "");
      out.push(<a key={key++} href={"mailto:" + addr}>{addr}</a>, m[1].slice(addr.length));
    } else out.push(<a key={key++} href="/privacy">{m[0]}</a>);
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
      <section className="hero page-hero" id="top">
        <div className="wrap">
          <h1 className="display hero-title" style={{ fontSize: "var(--mk-fs-h1)" }}>{copy.title}</h1>
          <div className="legal-body" style={{ marginTop: 36 }}>
            {copy.updated ? <p className="legal-updated">{copy.updated}</p> : null}
            {copy.intro?.map((p, i) => <p key={i}>{linked(p, privacy)}</p>)}
            {copy.sections.map((s) => (
              <section key={s.heading} className="legal-sec">
                <h2 className="display h3">{s.heading}</h2>
                {s.paragraphs?.map((p, i) => <p key={i}>{linked(p, privacy)}</p>)}
                {s.items?.length ? <ul>{s.items.map((it, i) => <li key={i}>{linked(it, privacy)}</li>)}</ul> : null}
              </section>
            ))}
            <p>{COPY.shared.footer.fineprint}</p>
          </div>
        </div>
      </section>
    </Site>
  );
}
