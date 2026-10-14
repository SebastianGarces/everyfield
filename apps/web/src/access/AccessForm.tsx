"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";
import { submitAccessRequest } from "./actions";
import { HONEYPOT, validateAccessRequest, type AccessRequestKind, type FieldErrorCode, type FieldErrors } from "./contract";

export type FieldSpec = {
  name: string;
  label: string;
  type: "text" | "email" | "select" | "area" | "number";
  optional?: boolean;
  help?: string;
  /** Message for a missing or wrongly formatted value. */
  error: string;
  /** Message for a value over the limit ({max} already filled in). */
  tooLong: string;
  placeholder?: string;
  /** First, empty option of a select. */
  prompt?: string;
  options?: readonly string[];
  autoComplete?: string;
};
export type Outcome = { title: string; body: string; link?: string };
export type OutcomeKey = "received" | "invalid" | "rate_limited_email" | "rate_limited_ip" | "unavailable" | "offline";
export type FormText = {
  eyebrow: string;
  headline: string;
  body: string;
  submit: string;
  submitting: string;
  optionalLabel: string;
  privacyNote: { text: string; link: string };
  contactEmail: string;
  outcomes: Record<OutcomeKey, Outcome>;
};
type Props = { kind: AccessRequestKind; id: string; fields: FieldSpec[]; text: FormText };

type Notice = Exclude<OutcomeKey, "received" | "invalid">;
type Phase = { s: "editing"; errors: FieldErrors; tried: boolean; notice?: Notice } | { s: "sending" } | { s: "received" };

const ARROW = (
  <svg className="i " viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);
const CHECK = (
  <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

/** Links each e-mail address in a sentence. */
function withMailto(text: string): ReactNode[] {
  return text.split(/([^\s@]+@[^\s@]+\.[a-z]{2,})/i).map((part, i) => {
    if (!(i % 2)) return part;
    const addr = part.replace(/[.,;:]+$/, "");
    return <span key={i}><a href={"mailto:" + addr}>{addr}</a>{part.slice(addr.length)}</span>;
  });
}
/** Links the first occurrence of `words` in `text` to `href`. */
function withLink(text: string, words: string, href: string): ReactNode {
  const i = text.indexOf(words);
  if (i < 0) return text;
  return <>{text.slice(0, i)}<a href={href}>{words}</a>{text.slice(i + words.length)}</>;
}

/**
 * One early access form (planter or network). Markup follows the prototype's form card. It adds labels tied to
 * inputs, help text, field errors, a hidden honeypot, a sending state and the outcome messages from the copy.
 * The same contract validates here (instant feedback) and in the server action (authority).
 * A failed send keeps every answer in the form.
 */
export function AccessForm({ kind, id, fields, text }: Props) {
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  // True while the pointer is down on the submit button. A blur check then would show an error, shift the
  // layout and move the button out from under the pointer, so the click would miss. Submit checks every field.
  const pressing = useRef(false);
  const focusAfterReply = useRef(false);
  const [phase, setPhase] = useState<Phase>({ s: "editing", errors: {}, tried: false });
  const [, startTransition] = useTransition();
  const errors = phase.s === "editing" ? phase.errors : {};
  const sending = phase.s === "sending";

  const read = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [k, v] of new FormData(formRef.current!)) if (typeof v === "string") out[k] = v;
    return out;
  };
  const focusFirst = (errs: FieldErrors) => {
    const first = fields.find((f) => errs[f.name]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first.name}"]`)?.focus();
  };
  // After the server answers, move focus to what changed: the first field error, or the message.
  useEffect(() => {
    if (!focusAfterReply.current || phase.s === "sending") return;
    focusAfterReply.current = false;
    if (phase.s === "editing" && !phase.notice) focusFirst(phase.errors);
    else msgRef.current?.focus();
  });
  // After the first submit, or once a field shows an error, errors follow what the person types.
  const recheck = (name: string, onBlur: boolean) => {
    if (phase.s !== "editing" || (onBlur && pressing.current)) return;
    if (!onBlur && !phase.tried && !phase.errors[name]) return;
    const values = read();
    const v = validateAccessRequest(kind, values);
    const code = v.ok ? undefined : v.fieldErrors[name];
    const next = { ...phase.errors };
    // On blur before the first submit, only flag a field the person has filled in.
    if (code && (phase.tried || !onBlur || values[name])) next[name] = code;
    else delete next[name];
    setPhase({ ...phase, errors: next });
  };

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    pressing.current = false;
    if (sending) return;
    const values = read();
    const v = validateAccessRequest(kind, values);
    if (!v.ok) {
      setPhase({ s: "editing", errors: v.fieldErrors, tried: true });
      focusFirst(v.fieldErrors);
      return;
    }
    setPhase({ s: "sending" });
    startTransition(async () => {
      let next: Phase;
      try {
        const r = await submitAccessRequest(kind, values);
        if (r.status === "received") next = { s: "received" };
        else if (r.status === "invalid") next = { s: "editing", errors: r.fieldErrors, tried: true };
        else if (r.status === "rate_limited") next = { s: "editing", errors: {}, tried: true, notice: r.reason === "email" ? "rate_limited_email" : "rate_limited_ip" };
        else next = { s: "editing", errors: {}, tried: true, notice: "unavailable" };
      } catch {
        // The request did not reach the server, or the reply was lost.
        next = { s: "editing", errors: {}, tried: true, notice: navigator.onLine ? "unavailable" : "offline" };
      }
      focusAfterReply.current = true;
      setPhase(next);
    });
  }

  const head = (
    <>
      <span className="eyebrow">{text.eyebrow}</span>
      <h2 className="display h3">{text.headline}</h2>
    </>
  );

  if (phase.s === "received") {
    const o = text.outcomes.received;
    return (
      <div className="form-card" id={id}>
        {head}
        <div className="form-msg show form-ok" role="status" tabIndex={-1} ref={msgRef}>
          <span className="form-ok-icon">{CHECK}</span>
          <div>
            <p className="form-ok-title">{o.title}</p>
            <p>{o.body}</p>
          </div>
        </div>
      </div>
    );
  }

  const notice = phase.s === "editing" && phase.notice ? text.outcomes[phase.notice] : null;
  const invalid = phase.s === "editing" && !phase.notice && Object.keys(errors).length ? text.outcomes.invalid : null;
  const message = (code: FieldErrorCode, f: FieldSpec) => (code === "too_long" ? f.tooLong : f.error);

  return (
    <form className="form-card" id={id} ref={formRef} onSubmit={onSubmit} noValidate aria-busy={sending} aria-describedby={`${uid}-body`}>
      {head}
      <p className="small" id={`${uid}-body`}>{text.body}</p>
      {fields.map((f) => {
        const fid = `${uid}-${f.name}`, err = errors[f.name];
        const describedBy = [f.help ? `${fid}-help` : "", err ? `${fid}-err` : ""].filter(Boolean).join(" ") || undefined;
        const common = {
          id: fid,
          name: f.name,
          required: !f.optional,
          "aria-invalid": err ? true : undefined,
          "aria-describedby": describedBy,
          autoComplete: f.autoComplete,
          onBlur: () => recheck(f.name, true),
          onChange: () => recheck(f.name, false),
        } as const;
        return (
          <div className="field" key={f.name}>
            <label htmlFor={fid}>
              {f.label}
              {f.optional ? <> <small>{text.optionalLabel}</small></> : null}
            </label>
            {f.type === "select" ? (
              <select {...common} defaultValue={f.prompt ? "" : f.options?.[0]}>
                {f.prompt ? <option value="" disabled>{f.prompt}</option> : null}
                {f.options?.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : f.type === "area" ? (
              <textarea {...common} readOnly={sending} placeholder={f.placeholder} />
            ) : (
              <input
                {...common}
                readOnly={sending}
                type={f.type === "number" ? "text" : f.type}
                inputMode={f.type === "number" ? "numeric" : f.type === "email" ? "email" : undefined}
                spellCheck={f.type === "email" ? false : undefined}
                placeholder={f.placeholder}
              />
            )}
            {f.help ? <p className="field-help" id={`${fid}-help`}>{f.help}</p> : null}
            {err ? <p className="field-error" id={`${fid}-err`}>{message(err, f)}</p> : null}
          </div>
        );
      })}
      <div className="hp-field" aria-hidden="true">
        <label htmlFor={`${uid}-${HONEYPOT}`}>Leave this field empty</label>
        <input id={`${uid}-${HONEYPOT}`} name={HONEYPOT} type="text" tabIndex={-1} autoComplete="off" />
      </div>
      <button
        className="mk-btn primary"
        type="submit"
        aria-disabled={sending || undefined}
        onPointerDown={() => { pressing.current = true; }}
        onPointerUp={() => setTimeout(() => { pressing.current = false; }, 0)}
        onPointerCancel={() => { pressing.current = false; }}
      >
        {sending ? text.submitting : text.submit}
        {sending ? <span className="mk-spin" aria-hidden="true" /> : ARROW}
      </button>
      <p className="form-note">{withLink(text.privacyNote.text, text.privacyNote.link, "/privacy")}</p>
      {notice ? (
        <div className="form-msg show form-fail" role="alert" tabIndex={-1} ref={msgRef}>
          <p className="form-msg-title">{notice.title}</p>
          <p>{notice.link ? notice.body : withMailto(notice.body)}</p>
          {notice.link ? <p><a href={"mailto:" + text.contactEmail}>{notice.link}</a></p> : null}
        </div>
      ) : (
        <div className={"form-msg" + (invalid ? " show form-fail" : "")} role="status">
          {invalid ? (
            <>
              <p className="form-msg-title">{invalid.title}</p>
              <p>{invalid.body}</p>
            </>
          ) : null}
        </div>
      )}
    </form>
  );
}
