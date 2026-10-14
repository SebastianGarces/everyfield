"use client";

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from "react";
import { submitAccessRequest } from "./actions";
import { HONEYPOT, validateAccessRequest, type AccessRequestKind, type FieldErrorCode, type FieldErrors } from "./contract";

export type FieldSpec = {
  name: string;
  label: string;
  type: "text" | "email" | "select" | "area" | "number";
  optional?: boolean;
  autoComplete?: string;
  options?: readonly string[];
};
export type FormMessages = {
  received_title: string;
  received_body: string;
  invalid: string;
  unavailable: string;
  sending: string;
} & Record<FieldErrorCode, string>;

type Props = {
  kind: AccessRequestKind;
  id: string;
  eyebrow: string;
  headline: string;
  body: string;
  submit: string;
  fields: FieldSpec[];
  messages: FormMessages;
};
type Phase = { s: "editing"; errors: FieldErrors; tried: boolean } | { s: "sending" } | { s: "received" } | { s: "unavailable" };

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

/** Turns every e-mail address in a sentence into a mailto link. */
function withMailto(text: string) {
  return text.split(/([^\s@]+@[^\s@]+\.[a-z]{2,})/i).map((part, i) =>
    i % 2 ? <a key={i} href={"mailto:" + part.replace(/[.,;:]+$/, "")}>{part}</a> : part,
  );
}

/**
 * One early access form (planter or network). Markup follows the prototype's form card; this adds labels tied to
 * inputs, field errors, a hidden honeypot, a sending state, and the received and unavailable messages.
 * The same contract validates here (instant feedback) and in the server action (authority).
 */
export function AccessForm({ kind, id, eyebrow, headline, body, submit, fields, messages }: Props) {
  const uid = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const msgRef = useRef<HTMLDivElement>(null);
  // True while the pointer is down on the submit button. A blur check then would show an error, shift the
  // layout and move the button out from under the pointer, so the click would miss. Submit checks every field.
  const pressing = useRef(false);
  const [phase, setPhase] = useState<Phase>({ s: "editing", errors: {}, tried: false });
  const [, startTransition] = useTransition();
  const errors = phase.s === "editing" ? phase.errors : {};
  // After the server answers, move focus to what changed: the first field error, or the result message.
  const focusAfterReply = useRef(false);

  const read = (): Record<string, string> => {
    const data = new FormData(formRef.current!);
    const out: Record<string, string> = {};
    for (const [k, v] of data) if (typeof v === "string") out[k] = v;
    return out;
  };
  const focusFirst = (errs: FieldErrors) => {
    const first = fields.find((f) => errs[f.name]);
    if (first) formRef.current?.querySelector<HTMLElement>(`[name="${first.name}"]`)?.focus();
  };
  useEffect(() => {
    if (!focusAfterReply.current || phase.s === "sending") return;
    focusAfterReply.current = false;
    if (phase.s === "editing") focusFirst(phase.errors);
    else msgRef.current?.focus();
  });
  // After the first submit, or once a field shows an error, errors follow what the person types.
  const recheck = (name: string, onBlur: boolean) => {
    if (phase.s !== "editing" || (onBlur && pressing.current)) return;
    if (!onBlur && !phase.tried && !phase.errors[name]) return;
    const v = validateAccessRequest(kind, read());
    const next = { ...phase.errors };
    const code = v.ok ? undefined : v.fieldErrors[name];
    // On blur, only flag a field the person has filled in; empty fields are flagged on submit.
    if (code && (onBlur && !phase.tried ? read()[name] : true)) next[name] = code;
    else delete next[name];
    setPhase({ ...phase, errors: next });
  };

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    pressing.current = false;
    if (phase.s === "sending") return;
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
        next = r.status === "invalid" ? { s: "editing", errors: r.fieldErrors, tried: true } : { s: r.status };
      } catch {
        next = { s: "unavailable" };
      }
      focusAfterReply.current = true;
      setPhase(next);
    });
  }

  const sending = phase.s === "sending";
  const errorCount = Object.keys(errors).length;
  const head = (
    <>
      <span className="eyebrow">{eyebrow}</span>
      <h2 className="display h3">{headline}</h2>
    </>
  );

  if (phase.s === "received") {
    return (
      <div className="form-card" id={id}>
        {head}
        <div className="form-msg show form-ok" role="status" tabIndex={-1} ref={msgRef}>
          <span className="form-ok-icon">{CHECK}</span>
          <div>
            <p className="form-ok-title">{messages.received_title}</p>
            <p>{messages.received_body}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <form className="form-card" id={id} ref={formRef} onSubmit={onSubmit} noValidate aria-busy={sending} aria-describedby={`${uid}-body`}>
      {head}
      <p className="small" id={`${uid}-body`}>{body}</p>
      {fields.map((f) => {
        const fid = `${uid}-${f.name}`, err = errors[f.name], errId = `${fid}-err`;
        const common = {
          id: fid,
          name: f.name,
          required: !f.optional,
          "aria-invalid": err ? true : undefined,
          "aria-describedby": err ? errId : undefined,
          autoComplete: f.autoComplete,
          disabled: sending,
          onBlur: () => recheck(f.name, true),
          onChange: () => recheck(f.name, false),
        } as const;
        return (
          <div className="field" key={f.name}>
            <label htmlFor={fid}>
              {f.label}
              {f.optional ? <> <small>(optional)</small></> : null}
            </label>
            {f.type === "select" ? (
              <select {...common} defaultValue={f.options?.[0]}>
                {f.options?.map((o) => <option key={o}>{o}</option>)}
              </select>
            ) : f.type === "area" ? (
              <textarea {...common} maxLength={2000} />
            ) : (
              <input {...common} type={f.type === "number" ? "text" : f.type} inputMode={f.type === "number" ? "numeric" : f.type === "email" ? "email" : undefined} spellCheck={f.type === "email" ? false : undefined} />
            )}
            {err ? <p className="field-error" id={errId}>{messages[err]}</p> : null}
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
        {sending ? messages.sending : submit}
        {sending ? <span className="mk-spin" aria-hidden="true" /> : ARROW}
      </button>
      {phase.s === "unavailable" ? (
        <div className="form-msg show form-fail" role="alert" tabIndex={-1} ref={msgRef}>{withMailto(messages.unavailable)}</div>
      ) : (
        <div className={"form-msg" + (errorCount ? " show form-fail" : "")} role="status">
          {errorCount ? messages.invalid : sending ? messages.sending : ""}
        </div>
      )}
    </form>
  );
}
