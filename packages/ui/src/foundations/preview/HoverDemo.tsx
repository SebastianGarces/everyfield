"use client";

import { useState } from "react";
import { HoverGroup, useHoverItem } from "..";

const ITEMS = ["Overview", "People", "Meetings", "Tasks"] as const;

/** A small HoverGroup: the highlight slides to the hovered or focused item and rests on the selected one. */
export function HoverDemo() {
  const [selected, setSelected] = useState<string>("People");
  return (
    <HoverGroup current={selected} role="group" aria-label="Hover group example" className="flex flex-wrap gap-0.5 self-start rounded-nav bg-surface-raised p-2 shadow-nav">
      {ITEMS.map((label) => (
        <DemoItem key={label} label={label} selected={selected === label} onSelect={() => setSelected(label)} />
      ))}
    </HoverGroup>
  );
}

function DemoItem({ label, selected, onSelect }: { label: string; selected: boolean; onSelect: () => void }) {
  const { handlers, indicator } = useHoverItem(label);
  return (
    <button type="button" aria-pressed={selected} onClick={onSelect} {...handlers}
      className="relative inline-flex h-11 items-center rounded-nav-item px-4 text-nav text-ink-2 aria-pressed:bg-ink aria-pressed:text-on-ink aria-pressed:shadow-nav-active">
      {indicator}
      {label}
    </button>
  );
}
