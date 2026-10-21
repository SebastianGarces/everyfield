"use client";

import { Button, buttonVariants, IntentLink, PageHeader } from "@everyfield/ui/controls";
import { useEffect, useRef, useState } from "react";
import { DoneStep, ImportStep, ReviewStep, Steps, UploadStep } from "./ImportSteps.tsx";
import {
	addCount,
	choicesPayload,
	fileRefusal,
	importRefusal,
	LOST_CHECK,
	MAX_BYTES,
	NOT_FOUND,
	UNCONFIRMED,
	plural,
	RECONNECTING,
	suggestedChoices,
	type ImportReceipt,
	type Notice,
	type Preview,
	type Review,
} from "./model.ts";

// People CSV import (REQ-PPL-018): upload, review every row, import as one background job, then the receipt. The
// file never leaves this page as parsed rows: the server reads the bytes itself, at preview and again at import.
// One import has one request key, made when the person presses Import. It lives in the address (?import=), so a
// lost reply or a reload reads the same import's receipt instead of starting a second one.

type State =
	| { step: "upload"; checking: File | null; error: Notice | null }
	| { step: "review"; review: Review; refusal: Notice | null }
	| { step: "import"; review: Review | null; key: string; receipt: ImportReceipt | null; trouble: Notice | null }
	| { step: "done"; review: Review | null; key: string; receipt: ImportReceipt };

/** What the page found for ?import= when it loaded. */
export type Initial =
	| { kind: "none" }
	| { kind: "receipt"; key: string; receipt: ImportReceipt }
	| { kind: "missing"; key: string }
	| { kind: "lost"; key: string };

type Answer<T> = { status: "ok"; value: T } | { status: "refused"; code: string; line?: number } | { status: "lost" };
async function call<T>(input: string, init?: RequestInit): Promise<Answer<T>> {
	try {
		const res = await fetch(input, { ...init, cache: "no-store" });
		const body = (await res.json().catch(() => null)) as Answer<T> | null;
		return body && (body.status === "ok" || body.status === "refused") ? body : { status: "lost" };
	} catch {
		return { status: "lost" };
	}
}
const readReceipt = (key: string) => call<ImportReceipt>(`/api/people/import?key=${encodeURIComponent(key)}`);
const address = (key: string | null) =>
	window.history.replaceState(null, "", key ? `/people/import?import=${key}` : "/people/import");

const finished = (r: ImportReceipt) => r.status !== "in_progress";

export function ImportScreen({ initial }: { initial: Initial }) {
	const [state, setState] = useState<State>(() => {
		if (initial.kind === "receipt")
			return finished(initial.receipt)
				? { step: "done", review: null, key: initial.key, receipt: initial.receipt }
				: { step: "import", review: null, key: initial.key, receipt: initial.receipt, trouble: null };
		if (initial.kind === "lost")
			return { step: "import", review: null, key: initial.key, receipt: null, trouble: LOST_CHECK };
		return {
			step: "upload",
			checking: null,
			error: initial.kind === "missing" ? NOT_FOUND : null,
		};
	});
	const heading = useRef<HTMLHeadingElement>(null);
	const step = state.step;
	// A new step or a blocking problem moves focus, so keyboard and screen reader users start there. A refusal on the
	// new step wins over its heading: the person must hear what went wrong first.
	const blocking = state.step === "import" && state.trouble !== RECONNECTING ? state.trouble?.title : null;
	const first = useRef(true);
	useEffect(() => {
		if (first.current) {
			first.current = false;
			return;
		}
		(document.querySelector<HTMLElement>("[data-import-problem]") ?? heading.current)?.focus();
	}, [step, blocking]);

	const check = async (picked: File) => {
		if (picked.size > MAX_BYTES) {
			setState({ step: "upload", checking: null, error: fileRefusal("file_too_large") });
			return;
		}
		setState({ step: "upload", checking: picked, error: null });
		// The reviewed bytes stay in memory, so the import sends exactly what was previewed even if the file on disk
		// changes or moves afterwards.
		const file = new File([await picked.arrayBuffer()], picked.name, { type: "text/csv" });
		const got = await call<Preview>("/api/people/import/preview", {
			method: "POST",
			headers: { "Content-Type": "text/csv" },
			body: file,
		});
		if (got.status === "ok")
			setState({
				step: "review",
				review: { file, preview: got.value, choices: suggestedChoices(got.value) },
				refusal: null,
			});
		else
			setState({
				step: "upload",
				checking: null,
				error: fileRefusal(got.status === "lost" ? "lost" : got.code, got.status === "refused" ? got.line : undefined),
			});
	};

	/** Sends the reviewed import under its key. The same key repeats it safely after a lost reply or a partial import. */
	const send = async (review: Review, key: string) => {
		setState({ step: "import", review, key, receipt: null, trouble: null });
		const form = new FormData();
		form.set("file", review.file);
		form.set(
			"review",
			JSON.stringify({
				requestKey: key,
				fileDigest: review.preview.fileDigest,
				reviewDigest: review.preview.reviewDigest,
				choices: choicesPayload(review.choices),
			}),
		);
		const got = await call<ImportReceipt>("/api/people/import", { method: "POST", body: form });
		if (got.status === "ok") return settle(review, key, got.value);
		if (got.status === "lost") return confirm(review, key);
		address(null);
		setState({ step: "review", review, refusal: importRefusal(got.code) });
	};

	/** After a lost reply: the receipt says whether the import started. Nothing is sent again without a press. */
	const confirm = async (review: Review | null, key: string) => {
		setState({ step: "import", review, key, receipt: null, trouble: null });
		const got = await readReceipt(key);
		if (got.status === "ok") return settle(review, key, got.value);
		// A refusal does not prove that nothing was saved (see UNCONFIRMED), so the screen sends nothing again.
		setState({ step: "import", review, key, receipt: null, trouble: got.status === "lost" ? LOST_CHECK : UNCONFIRMED });
	};

	const settle = (review: Review | null, key: string, receipt: ImportReceipt) =>
		setState(
			finished(receipt)
				? { step: "done", review, key, receipt }
				: { step: "import", review, key, receipt, trouble: null },
		);

	// While the job runs, read its receipt about once a second. A failed read waits longer, then tries again.
	const running = state.step === "import" && state.receipt !== null ? state : null;
	const runningKey = running?.key;
	useEffect(() => {
		if (!runningKey) return;
		let wait = 1000;
		let timer: ReturnType<typeof setTimeout>;
		let stopped = false;
		const tick = async () => {
			const got = await readReceipt(runningKey);
			if (stopped) return;
			if (got.status === "ok") {
				wait = 1000;
				setState((s) => (s.step === "import" && s.key === runningKey ? next(s, got.value) : s));
				if (finished(got.value)) return;
			} else if (got.status === "refused") {
				setState((s) => (s.step === "import" && s.key === runningKey ? { ...s, trouble: UNCONFIRMED } : s));
				return;
			} else {
				wait = Math.min(wait * 2, 8000);
				setState((s) => (s.step === "import" && s.key === runningKey ? { ...s, trouble: RECONNECTING } : s));
			}
			timer = setTimeout(tick, wait);
		};
		timer = setTimeout(tick, wait);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [runningKey]);

	const startOver = () => {
		address(null);
		setState({ step: "upload", checking: null, error: null });
	};

	const review = state.step === "review" ? state.review : null;
	const adding = review ? addCount(review.choices) : 0;
	const fileName = state.step === "upload" ? null : (state.review?.file.name ?? null);

	return (
		<>
			<PageHeader
				size="xl"
				title="Import people"
				breadcrumb={[{ label: "People", href: "/people" }, { label: "Import" }]}
				subtitle={
					review
						? `${review.file.name} · ${plural(review.preview.counts.rows, "row")}`
						: fileName
							? fileName
							: "Add the people you already know from a spreadsheet."
				}
				actions={
					review ? (
						<>
							<Button variant="ghost" onClick={startOver}>
								Choose another file
							</Button>
							<Button
								variant="primary"
								disabled={adding === 0}
								onClick={() => {
									const key = crypto.randomUUID();
									address(key);
									void send(review, key);
								}}
							>
								{adding === 0 ? "Nobody to import" : `Import ${plural(adding, "person", "people")}`}
							</Button>
						</>
					) : state.step === "upload" ? (
						<IntentLink href="/people" className={buttonVariants({ variant: "ghost" })}>
							Cancel
						</IntentLink>
					) : null
				}
			/>
			<Steps current={state.step} />
			{state.step === "upload" ? (
				<UploadStep heading={heading} checking={state.checking} error={state.error} onFile={check} />
			) : state.step === "review" ? (
				<ReviewStep
					heading={heading}
					review={state.review}
					refusal={state.refusal}
					onChoices={(choices) => setState({ ...state, review: { ...state.review, choices }, refusal: null })}
					onCheckAgain={() => check(state.review.file)}
				/>
			) : state.step === "import" ? (
				<ImportStep
					heading={heading}
					receipt={state.receipt}
					trouble={state.trouble}
					onRetry={state.trouble === LOST_CHECK ? () => confirm(state.review, state.key) : null}
					onStartOver={startOver}
				/>
			) : (
				<DoneStep
					heading={heading}
					receipt={state.receipt}
					review={state.review}
					onRetry={state.review ? () => send(state.review!, state.key) : null}
					onStartOver={startOver}
				/>
			)}
		</>
	);
}

function next(s: Extract<State, { step: "import" }>, receipt: ImportReceipt): State {
	return finished(receipt) ? { step: "done", review: s.review, key: s.key, receipt } : { ...s, receipt, trouble: null };
}
