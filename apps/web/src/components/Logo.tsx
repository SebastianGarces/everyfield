import { LOGO_SYMBOLS } from "@/marketing/logo-symbols";
import { cn } from "./cn";

// logo-symbols.ts stays the single source of the logo paths: the share-image renderer and the apple icon read it too.
// It is parsed once, when the module loads, into typed symbols that render as JSX.
type Path = { d: string; evenOdd: boolean };
type Symbol = { id: "ef-symbol" | "ef-wordmark"; viewBox: string; paths: Path[] };

function parse(src: string): Symbol[] {
	const out: Symbol[] = [];
	for (const m of src.matchAll(/<symbol id="(ef-symbol|ef-wordmark)" viewBox="([^"]+)">([\s\S]*?)<\/symbol>/g)) {
		const paths = [...m[3]!.matchAll(/<path([^>]*)\/>/g)].map((p) => {
			const d = p[1]!.match(/\sd="([^"]+)"/)?.[1];
			if (!d) throw new Error(`logo-symbols.ts: a path in ${m[1]} has no d`);
			return { d, evenOdd: /fill-rule="evenodd"/.test(p[1]!) };
		});
		out.push({ id: m[1] as Symbol["id"], viewBox: m[2]!, paths });
	}
	if (out.length !== 2) throw new Error("logo-symbols.ts: expected the ef-symbol and ef-wordmark symbols");
	return out;
}
const SYMBOLS = parse(LOGO_SYMBOLS);

/** The logo sprite: the symbol, the wordmark and the lockup (1308x241: the symbol 192.33 high, centred on the wordmark
 *  band). Rendered once per page; every logo and the app frames of the product pictures reference it with <use>. */
export function LogoSymbols() {
	return (
		<svg width="0" height="0" className="absolute" aria-hidden="true">
			{SYMBOLS.map((s) => (
				<symbol key={s.id} id={s.id} viewBox={s.viewBox}>
					{s.paths.map((p, i) => (
						<path
							key={i}
							d={p.d}
							fill="currentColor"
							{...(p.evenOdd ? { fillRule: "evenodd", clipRule: "evenodd" } : {})}
						/>
					))}
				</symbol>
			))}
			<symbol id="ef-lockup" viewBox="0 0 1308 241">
				<use href="#ef-symbol" x="0" y="23.668" width="192.33" height="192.33" />
				<use href="#ef-wordmark" x="256.489" y="0" width="1052" height="241" />
			</symbol>
		</svg>
	);
}

/** The symbol alone, square, sized by the caller. Decorative. */
export function Mark({ className }: { className?: string }) {
	return (
		<svg viewBox="0 0 340 340" aria-hidden="true" className={cn("block", className)}>
			<use href="#ef-symbol" />
		</svg>
	);
}

/**
 * "nav": the ink lockup. "pill": the nav logo, which keeps only the symbol at 440 px and below. "footer": the cream
 * wordmark on the ink footer card.
 */
export function Logo({ variant }: { variant: "nav" | "pill" | "footer" }) {
	if (variant === "footer")
		return (
			<svg viewBox="0 0 1052 241" role="img" aria-label="Everyfield" className="block h-5 w-auto flex-none text-cream">
				<use href="#ef-wordmark" />
			</svg>
		);
	return (
		<span className="inline-flex flex-none items-center text-ink">
			<svg
				viewBox="0 0 1308 241"
				role="img"
				aria-label="Everyfield"
				className={cn("block h-7 w-auto max-mk-sm:h-6", variant === "pill" && "max-mk-xs:hidden")}
			>
				<use href="#ef-lockup" />
			</svg>
			{variant === "pill" ? (
				<svg viewBox="0 0 340 340" role="img" aria-label="Everyfield" className="hidden size-[22px] max-mk-xs:block">
					<use href="#ef-symbol" />
				</svg>
			) : null}
		</span>
	);
}
