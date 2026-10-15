import { LOGO_SYMBOLS } from "@/marketing/logo-symbols";
import { cn } from "./cn";

// logo-symbols.ts stays the single source of the logo paths: the share-image renderer and the apple icon read it too.
// It is parsed once, when the module loads, into typed symbols that render as JSX.
type Path = { d: string; evenOdd: boolean };
type Symbol = { id: "ef-mark" | "ef-wordmark"; viewBox: string; paths: Path[] };

function parse(src: string): Symbol[] {
  const out: Symbol[] = [];
  for (const m of src.matchAll(/<symbol id="(ef-mark|ef-wordmark)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)) {
    const paths = [...m[3]!.matchAll(/<path([^>]*)\/>/g)].map((p) => {
      const d = p[1]!.match(/\sd="([^"]+)"/)?.[1];
      if (!d) throw new Error(`logo-symbols.ts: a path in ${m[1]} has no d`);
      return { d, evenOdd: /fill-rule="evenodd"/.test(p[1]!) };
    });
    out.push({ id: m[1] as Symbol["id"], viewBox: m[2]!, paths });
  }
  if (out.length !== 2) throw new Error("logo-symbols.ts: expected the ef-mark and ef-wordmark symbols");
  return out;
}
const SYMBOLS = parse(LOGO_SYMBOLS);

/** The logo sprite. Rendered once per page; every logo and the app frames of the product pictures reference it with <use>. */
export function LogoSymbols() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      {SYMBOLS.map((s) => (
        <symbol key={s.id} id={s.id} viewBox={s.viewBox}>
          {s.paths.map((p, i) => (
            <path key={i} d={p.d} fill="currentColor" {...(p.evenOdd ? { fillRule: "evenodd", clipRule: "evenodd" } : {})} />
          ))}
        </symbol>
      ))}
    </svg>
  );
}

/** The mark alone, sized by the caller. Decorative. */
export function Mark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 657 530" aria-hidden="true" className={cn("block", className)}>
      <use href="#ef-mark" />
    </svg>
  );
}

/**
 * Mark plus wordmark. "nav": green mark, ink wordmark; the wordmark viewBox is padded (-26.4 to 190) so its box centre
 * is the cap-height centre. "pill": the nav logo, without the wordmark at 440 px and below. "footer": white, smaller.
 */
export function Logo({ variant }: { variant: "nav" | "pill" | "footer" }) {
  const nav = variant !== "footer";
  return (
    <span className={cn("inline-flex flex-none items-center gap-2.5 no-underline", nav ? "text-ink" : "text-white")}>
      <svg viewBox="0 0 657 530" aria-hidden="true" className={cn("block", nav ? "h-[22px] w-[27px] text-green max-mk-sm:h-[19px] max-mk-sm:w-6" : "h-4 w-5")}>
        <use href="#ef-mark" />
      </svg>
      <svg
        viewBox={nav ? "0 -26.4 890 216.4" : "0 0 890 186"}
        role="img"
        aria-label="EveryField"
        className={cn(
          "block overflow-visible",
          nav ? "h-[27.3px] w-28 max-mk-sm:h-[23.4px] max-mk-sm:w-24" : "h-[18px] w-[84px]",
          variant === "pill" && "max-mk-xs:hidden",
        )}
      >
        {nav ? <use href="#ef-wordmark" width="890" height="186" /> : <use href="#ef-wordmark" />}
      </svg>
    </span>
  );
}
