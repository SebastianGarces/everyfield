"use client";

import { Alert02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { AlertDialog, Dialog as DialogPrimitive } from "radix-ui";
import { useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn, Icon, type IconSvgElement } from "../foundations";
import { Button, IconButton } from "./Button";
import { CardIcon, type Tone } from "./Card";
import { usePortalContainer, useReturnFocus } from "./overlay-portal";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const SCRIM = "ef-scrim fixed inset-0 z-50 bg-ink-fixed/28 backdrop-blur-[2px]";
const PANEL = "ef-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-[28px] bg-surface-raised text-md text-ink shadow-pop outline-none";
const WIDTH = { sm: "max-w-[440px]", md: "max-w-[560px]", lg: "max-w-[720px]" } as const;

type DialogContentProps = ComponentPropsWithRef<typeof DialogPrimitive.Content> & {
  /** sm 440 · md 560 (the prototype) · lg 720. Below these it fills the screen less 12px each side. */
  size?: keyof typeof WIDTH;
};

/**
 * Dialog (components.md): a modal with aria-modal. Focus moves in on open, Tab stays inside, Esc and the scrim close
 * it and focus returns to the trigger. The page behind is inert. Compose it from DialogHeader, DialogBody and
 * DialogFooter. A long body scrolls inside the dialog, so the header and footer stay in view.
 */
export function DialogContent({ size = "md", className, children, onOpenAutoFocus, onCloseAutoFocus, ...props }: DialogContentProps) {
  const container = usePortalContainer();
  const focus = useReturnFocus({ onOpenAutoFocus, onCloseAutoFocus });
  return (
    <DialogPrimitive.Portal container={container}>
      <DialogPrimitive.Overlay className={SCRIM} />
      <DialogPrimitive.Content aria-modal="true" className={cn(PANEL, WIDTH[size], className)} {...props} {...focus}>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

type DialogHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  icon?: IconSvgElement;
  tone?: Tone;
  /** Hide the close button only when the footer has an explicit way out. */
  closable?: boolean;
};

/** Icon, Title, Description and Close. The title and description name and describe the dialog. */
export function DialogHeader({ title, description, icon, tone = "ink", closable = true }: DialogHeaderProps) {
  return (
    <div className="flex flex-none items-start gap-4 px-7 pt-[26px] pb-4 max-app-sm:px-5 max-app-sm:pt-5">
      {icon ? <CardIcon icon={icon} tone={tone} /> : null}
      <div className="min-w-0 flex-1">
        <DialogPrimitive.Title className="font-display text-title-md leading-[1.2] font-medium tracking-[-0.02em] text-ink text-balance">{title}</DialogPrimitive.Title>
        {description ? <DialogPrimitive.Description className="mt-1 text-md text-text-3">{description}</DialogPrimitive.Description> : null}
      </div>
      {closable ? (
        <DialogPrimitive.Close asChild>
          <IconButton icon={Cancel01Icon} label="Close" size="sm" />
        </DialogPrimitive.Close>
      ) : null}
    </div>
  );
}

export function DialogBody({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto px-7 text-text-2 max-app-sm:px-5", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: ComponentPropsWithRef<"div">) {
  return <div className={cn("flex flex-none flex-wrap items-center justify-end gap-2.5 px-7 pt-6 pb-[26px] max-app-sm:px-5 max-app-sm:pb-5 max-app-sm:*:flex-1", className)} {...props} />;
}

type ConfirmDialogProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The element that opens the dialog, when it is not controlled. */
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** What will happen, one item per consequence. Shown as a list so nothing hides in a sentence. */
  consequences?: ReactNode[];
  /** The action's own words ("Hide article"), never "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /**
   * Runs the action. While it runs, the confirm button shows a spinner and the dialog stays open. A thrown error is
   * shown in the dialog with the message from the error, and the dialog stays open so the person can try again.
   */
  onConfirm: () => void | Promise<void>;
};

/**
 * ConfirmDialog (components.md, Hide dialog): an alert dialog for an action that needs a deliberate yes. Focus starts
 * on Cancel, so Enter never confirms by accident. tone="danger" marks a destructive action.
 */
export function ConfirmDialog({ open, onOpenChange, trigger, title, description, consequences, confirmLabel, cancelLabel = "Cancel", tone = "default", onConfirm }: ConfirmDialogProps) {
  const container = usePortalContainer();
  const focus = useReturnFocus();
  const [inner, setInner] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isOpen = open ?? inner;
  const setOpen = (next: boolean) => {
    if (pending) return;
    if (!next) setError(null);
    setInner(next);
    onOpenChange?.(next);
  };

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setPending(false);
      setInner(false);
      onOpenChange?.(false);
    } catch (e) {
      setPending(false);
      setError(e instanceof Error && e.message ? e.message : "The action did not finish. Try again.");
    }
  };

  return (
    <AlertDialog.Root open={isOpen} onOpenChange={setOpen}>
      {trigger ? <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger> : null}
      <AlertDialog.Portal container={container}>
        <AlertDialog.Overlay className={SCRIM} />
        <AlertDialog.Content aria-modal="true" className={cn(PANEL, WIDTH.sm)} {...focus}>
          <div className="flex flex-none items-start gap-4 px-7 pt-[26px] pb-4 max-app-sm:px-5 max-app-sm:pt-5">
            {tone === "danger" ? <CardIcon icon={Alert02Icon} tone="magenta" /> : null}
            <div className="min-w-0 flex-1">
              <AlertDialog.Title className="font-display text-title-md leading-[1.2] font-medium tracking-[-0.02em] text-ink text-balance">{title}</AlertDialog.Title>
              {description ? <AlertDialog.Description className="mt-1 text-md text-text-2">{description}</AlertDialog.Description> : null}
            </div>
          </div>
          {consequences?.length ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-7 max-app-sm:px-5">
              <ul className="flex flex-col gap-2 rounded-md bg-surface px-5 py-4 text-text-2">
                {consequences.map((c, i) => (
                  <li key={i} className="flex gap-2.5"><span aria-hidden="true" className="mt-[9px] size-1.5 flex-none rounded-full bg-text-3" />{c}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div aria-live="assertive" className="px-7 empty:hidden max-app-sm:px-5">
            {error ? (
              <p className="mt-4 flex items-start gap-2 rounded-md bg-magenta-50 px-3.5 py-2.5 text-sm text-magenta-600">
                <Icon icon={Alert02Icon} size={16} className="mt-px" />
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex flex-none flex-wrap items-center justify-end gap-2.5 px-7 pt-6 pb-[26px] max-app-sm:px-5 max-app-sm:pb-5 max-app-sm:*:flex-1">
            <AlertDialog.Cancel asChild>
              <Button variant="secondary" disabled={pending}>{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <Button variant={tone === "danger" ? "danger" : "primary"} loading={pending} onClick={confirm}>{confirmLabel}</Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

type SheetProps = {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /**
   * modal (default) traps focus and makes the page inert. Non-modal keeps the page usable beside the panel (Guide
   * and Evry), still closes with Esc and does not close on an outside click.
   */
  modal?: boolean;
  /** Header actions left of the close button. */
  actions?: ReactNode;
  footer?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Sheet: a panel from the right edge for the Guide panel and similar side content. Full width below 640px. */
export function Sheet({ open, onOpenChange, trigger, title, description, modal = true, actions, footer, children, className }: SheetProps) {
  const container = usePortalContainer();
  const focus = useReturnFocus();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} modal={modal}>
      {trigger ? <DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger> : null}
      <DialogPrimitive.Portal container={container}>
        {modal ? <DialogPrimitive.Overlay className={cn(SCRIM, "bg-ink-fixed/12 backdrop-blur-none")} /> : null}
        <DialogPrimitive.Content
          aria-modal={modal ? "true" : undefined}
          {...focus}
          onInteractOutside={modal ? undefined : (e) => e.preventDefault()}
          className={cn("ef-sheet fixed top-3 right-3 bottom-3 z-50 flex w-[420px] max-w-[calc(100vw-24px)] flex-col rounded-[26px] bg-surface-raised text-md text-ink shadow-pop outline-none max-app-sm:top-0 max-app-sm:right-0 max-app-sm:bottom-0 max-app-sm:w-full max-app-sm:max-w-none max-app-sm:rounded-none", className)}
        >
          <div className="flex flex-none items-start gap-3 border-b border-line px-6 pt-5 pb-4">
            <div className="min-w-0 flex-1">
              <DialogPrimitive.Title className="font-display text-title-sm leading-[1.2] font-medium tracking-[-0.02em] text-ink">{title}</DialogPrimitive.Title>
              {description ? <DialogPrimitive.Description className="mt-1 text-sm text-text-3">{description}</DialogPrimitive.Description> : null}
            </div>
            {actions}
            <DialogPrimitive.Close asChild>
              <IconButton icon={Cancel01Icon} label="Close" size="sm" />
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5 text-text-2">{children}</div>
          {footer ? <div className="flex flex-none flex-wrap items-center gap-2.5 border-t border-line bg-surface px-6 py-3.5 max-app-sm:rounded-none rounded-b-[26px]">{footer}</div> : null}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
