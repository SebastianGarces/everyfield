"use client";

import { Alert02Icon, Cancel01Icon, InformationCircleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { Toast as ToastPrimitive } from "radix-ui";
import { createContext, use, useCallback, useState, type ReactNode } from "react";
import { cn, Icon } from "../foundations";

export type ToastTone = "success" | "info" | "error";

export type ToastInput = {
  message: ReactNode;
  tone?: ToastTone;
  /**
   * One follow-up action, such as "View task". Never "Undo": records are corrected with history, not undone
   * (design/handoff/README.md). `altText` tells screen reader users how to reach the same action elsewhere.
   */
  action?: { label: string; altText: string; onSelect: () => void };
  /** Milliseconds before it closes. Hover and focus pause it. Errors stay until closed. */
  duration?: number;
};

type ToastItem = ToastInput & { id: number };
const ToastContext = createContext<((toast: ToastInput) => void) | null>(null);

/** Shows a toast. Needs a ToastProvider above it. */
export function useToast(): (toast: ToastInput) => void {
  const show = use(ToastContext);
  if (!show) throw new Error("useToast needs a ToastProvider above it.");
  return show;
}

const ICON = { success: Tick02Icon, info: InformationCircleIcon, error: Alert02Icon } as const;
const ICON_TONE = { success: "text-green-300", info: "text-blue-300", error: "text-magenta-300" } as const;

let nextId = 0;

/**
 * Toast (components.md): Icon, Message and Action, at the bottom center. Success and info toasts are polite status
 * messages; error toasts are assertive and stay until closed. F8 moves focus to the toast region. Swipe right closes.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const show = useCallback((toast: ToastInput) => setToasts((all) => [...all, { ...toast, id: ++nextId }]), []);
  const remove = (id: number) => setToasts((all) => all.filter((t) => t.id !== id));

  return (
    <ToastContext value={show}>
      <ToastPrimitive.Provider swipeDirection="right" label="Notifications">
        {children}
        {toasts.map(({ id, message, tone = "success", action, duration }) => (
          <ToastPrimitive.Root
            key={id}
            type={tone === "error" ? "foreground" : "background"}
            duration={duration ?? (tone === "error" ? Infinity : 5000)}
            onOpenChange={(open) => !open && setTimeout(() => remove(id), 200)}
            className="ef-toast flex w-full items-center gap-3 rounded-[16px] bg-ink py-3 pr-3 pl-4 text-md text-on-ink shadow-pop"
          >
            <span aria-hidden="true" className={cn("grid size-7 flex-none place-items-center rounded-full bg-on-ink-soft", ICON_TONE[tone])}>
              <Icon icon={ICON[tone]} size={16} />
            </span>
            <ToastPrimitive.Description className="min-w-0 flex-1">{message}</ToastPrimitive.Description>
            {action ? (
              <ToastPrimitive.Action altText={action.altText} asChild>
                <button type="button" onClick={action.onSelect} className="h-8 flex-none cursor-pointer rounded-sm bg-on-ink-soft px-2.5 text-sm font-medium text-on-ink transition-[background-color] hover:bg-[color-mix(in_srgb,var(--ef-on-ink)_20%,transparent)]">
                  {action.label}
                </button>
              </ToastPrimitive.Action>
            ) : null}
            <ToastPrimitive.Close aria-label="Close" className="grid size-8 flex-none cursor-pointer place-items-center rounded-sm text-on-ink opacity-80 transition-[opacity,background-color] hover:bg-on-ink-soft hover:opacity-100">
              <Icon icon={Cancel01Icon} size={16} />
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport className="fixed bottom-6 left-1/2 z-[60] m-0 flex w-[440px] max-w-[calc(100vw-24px)] -translate-x-1/2 list-none flex-col gap-2.5 p-0 outline-none max-app-sm:bottom-3" />
      </ToastPrimitive.Provider>
    </ToastContext>
  );
}
