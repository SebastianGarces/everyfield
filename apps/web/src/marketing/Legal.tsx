import { COPY, type LegalCopy } from "./copy";
import { Site } from "./Site";

/**
 * The privacy and terms pages. They render whatever copy shared.privacy_page / shared.terms_page holds
 * (task E2). Without copy they show the prototype's placeholder.
 */
export function Legal({ path, fallbackTitle, copy }: { path: string; fallbackTitle: string; copy?: LegalCopy }) {
  const title = copy?.title ?? fallbackTitle;
  const sections = copy?.sections ?? [];
  return (
    <Site path={path}>
      <section className="hero page-hero" id="top">
        <div className="wrap">
          <h1 className="display hero-title" style={{ fontSize: "var(--mk-fs-h1)" }}>{title}</h1>
          <div className="legal-body" style={{ marginTop: 36 }}>
            {copy?.updated ? <p className="legal-updated">{copy.updated}</p> : null}
            {copy?.intro ? <p>{copy.intro}</p> : null}
            {sections.length === 0 && !copy?.intro ? (
              <p>{`The full ${title.toLowerCase()} will be published here before EveryField launches.`}</p>
            ) : null}
            {sections.map((s) => (
              <section key={s.heading} className="legal-sec">
                <h2 className="display h3">{s.heading}</h2>
                {s.paragraphs?.map((p, i) => <p key={i}>{p}</p>)}
                {s.items?.length ? <ul>{s.items.map((it, i) => <li key={i}>{it}</li>)}</ul> : null}
              </section>
            ))}
            <p>{COPY.shared.footer.fineprint}</p>
          </div>
        </div>
      </section>
    </Site>
  );
}
