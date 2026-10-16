import { cn } from "@/components/cn";
import { VARIANTS, type VariantId } from "./variants";

/** R6 prototype switcher: a small fixed pill at the bottom of the home variants (fixed, so it shifts nothing). */
export function ProtoBar({ current }: { current: VariantId }) {
  const v = VARIANTS.find((x) => x.id === current)!;
  return (
    <nav aria-label="Prototype variants" className="fixed inset-x-0 bottom-[max(12px,env(safe-area-inset-bottom))] z-50 flex justify-center px-3">
      <div className="flex items-center gap-1 rounded-full bg-ink p-1 pl-3.5 text-[13px] text-white shadow-mk-app">
        <span className="mr-1.5 max-w-[42vw] truncate font-medium opacity-80 max-mk-xs:hidden" title={v.title}>{v.title}</span>
        {VARIANTS.map((x) => (
          <a
            key={x.id}
            href={x.path}
            aria-current={x.id === current ? "page" : undefined}
            title={x.title}
            className={cn(
              "grid h-10 min-w-10 place-items-center rounded-full px-3 font-semibold [transition:background-color_.15s,color_.15s]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-500",
              x.id === current ? "bg-green-500 text-ink" : "text-white hover:bg-ink-2",
            )}
          >
            {x.label}
          </a>
        ))}
      </div>
    </nav>
  );
}
