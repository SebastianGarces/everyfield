"use client";

import { ArrowDown01Icon, ArrowUp01Icon, SortingIcon } from "@hugeicons/core-free-icons";
import { Button, CalloutLabel, CalloutText, Card, IconButton, Skeleton, Tooltip } from "@everyfield/ui/controls";
import { LoadableView, StatusBadge, type Loadable } from "@everyfield/ui/display";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { OrderRead, OrderRow } from "../port";
import { newRequestKey } from "../port";
import { SaveError, SaveFooter, SectionBody } from "../SettingsDialog";
import { useDraft, useFlowState, useSettings } from "../store";
import {
	moved,
	orderNeeded,
	orderOf,
	rowsInOrder,
	savedView,
	saveRefusal,
	type OrderKind,
	type WikiOrder,
	type WikiOrderView,
} from "./wikiOrder";

const LIST: Record<OrderKind, { title: string; description: string; empty: string }> = {
	churches: {
		title: "Churches",
		description: "Sending churches that share their Wiki with your church.",
		empty: "No sending church shares a Wiki with your church.",
	},
	networks: {
		title: "Networks",
		description: "Sending networks that share their Wiki with your church.",
		empty: "No sending network shares a Wiki with your church.",
	},
};

/**
 * Wiki sources (T-26): the order in which the church reads its sending churches' and networks' Wiki versions. The
 * first entry of each list is the preferred one; the other versions stay in each article's Source menu. Nothing is
 * saved until Save order, and the save sends the revision this read returned, so an order saved elsewhere since is
 * refused rather than overwritten.
 */
export function WikiSourcesSection() {
	const { port } = useSettings();
	const [view, setView] = useFlowState<WikiOrderView | null>("wiki.order", null);
	const [failed, setFailed] = useState<number | null>(null);
	const [attempt, setAttempt] = useState(0);

	const load = useCallback(async (): Promise<WikiOrderView | null> => {
		const reply = await port.wiki.read().catch((): OrderRead => ({ status: "lost" }));
		if (reply.status !== "ok") return null;
		setView(reply);
		return reply;
	}, [port, setView]);

	useEffect(() => {
		if (view && attempt === 0) return;
		let live = true;
		void load().then((loaded) => live && !loaded && setFailed(attempt));
		return () => {
			live = false;
		};
		// The stored value is read once; Try again bumps the attempt.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [attempt, load]);

	const state: Loadable<WikiOrderView> =
		failed === attempt
			? {
					status: "error",
					title: "The Wiki sources did not load",
					meta: "Everyfield could not read your church's source order.",
					onRetry: () => setAttempt((n) => n + 1),
				}
			: view
				? { status: "ready", data: view }
				: { status: "loading" };

	return (
		<LoadableView
			state={state}
			empty={{ title: "" }}
			loadingLabel="Loading Wiki sources"
			skeleton={
				<SectionBody>
					<div className="mt-4 flex flex-col gap-4">
						{[0, 1].map((i) => (
							<Skeleton key={i} shape="block" height={132} />
						))}
					</div>
				</SectionBody>
			}
		>
			{(ready) => <OrderEditor view={ready} setView={setView} load={load} />}
		</LoadableView>
	);
}

function OrderEditor({
	view,
	setView,
	load,
}: {
	view: WikiOrderView;
	setView: (next: WikiOrderView) => void;
	load: () => Promise<WikiOrderView | null>;
}) {
	const { port } = useSettings();
	const { draft, setDraft, dirty, saving, refusal, save } = useDraft<WikiOrder>("wiki", orderOf(view));
	const [saved, setSaved] = useState(false);
	const [loading, setLoading] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const focusNext = useRef<{ id: string; step: -1 | 1 } | null>(null);
	const lists = useRef<HTMLDivElement>(null);

	// After a move, focus stays on the moved entry's control, or its other control once it reaches an end.
	useEffect(() => {
		const target = focusNext.current;
		if (!target) return;
		focusNext.current = null;
		const button = (step: number) =>
			lists.current?.querySelector<HTMLButtonElement>(`[data-move="${target.id}"][data-step="${step}"]`);
		const same = button(target.step);
		(same && !same.disabled ? same : button(-target.step))?.focus();
	}, [draft]);

	const move = (kind: OrderKind, row: OrderRow, index: number, step: -1 | 1) => {
		const ids = moved(draft[kind], index, step);
		focusNext.current = { id: row.id, step };
		setSaved(false);
		setAnnouncement(`${row.name} moved to position ${index + step + 1} of ${ids.length}.`);
		setDraft({ ...draft, [kind]: ids });
	};

	const onSave = () =>
		void save(async (sent) => {
			setSaved(false);
			const reply = await port.wiki
				.save(newRequestKey("wiki-order"), view.revision, sent.churches, sent.networks)
				.catch(() => ({ status: "lost" }) as const);
			if (reply.status !== "ok") return { ok: false, refusal: saveRefusal(reply) };
			setView(savedView(view, sent, reply.revision));
			setSaved(true);
			setAnnouncement("");
			return { ok: true, server: sent };
		});

	const loadCurrent = async () => {
		setLoading(true);
		const current = await load();
		setLoading(false);
		if (current) setDraft(orderOf(current));
	};

	return (
		<>
			<SectionBody>
				<div className="mt-4 flex flex-col gap-4">
					<div aria-live="polite" className="empty:hidden">
						{saved && !dirty ? (
							<p className="flex flex-wrap items-center gap-2.5 text-sm text-text-2">
								<StatusBadge status="positive" size="sm" fill="soft">
									Saved
								</StatusBadge>
								Order saved. Articles now open in this order.
							</p>
						) : null}
					</div>
					{orderNeeded(view) ? (
						<Card variant="callout" as="section" aria-label="No order set yet">
							<CalloutLabel tone="amber" icon={SortingIcon}>
								No order set yet
							</CalloutLabel>
							<CalloutText>
								Until you save one, an article that more than one of these churches edited shows “Order needed”, and
								people read the network or global version instead.
							</CalloutText>
						</Card>
					) : null}
					<div ref={lists} className="flex flex-col gap-4">
						{(["churches", "networks"] as const).map((kind) => (
							<OrderList
								key={kind}
								kind={kind}
								rows={rowsInOrder(view[kind], draft[kind])}
								disabled={saving}
								onMove={move}
							/>
						))}
					</div>
					<p className="text-sm text-text-3">
						The first entry in each list is what people read first. The other versions stay in each article’s Source
						menu.
					</p>
				</div>
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>
			</SectionBody>
			<SaveFooter
				section="wiki"
				label="Save order"
				dirty={dirty}
				saving={saving}
				onSave={onSave}
				error={
					refusal ? (
						<SaveError
							message={refusal.message}
							action={
								refusal.code === "conflict" ? (
									<Button size="sm" variant="secondary" onClick={() => void loadCurrent()} loading={loading}>
										Load current order
									</Button>
								) : undefined
							}
						/>
					) : undefined
				}
			/>
		</>
	);
}

function OrderList({
	kind,
	rows,
	disabled,
	onMove,
}: {
	kind: OrderKind;
	rows: OrderRow[];
	disabled: boolean;
	onMove: (kind: OrderKind, row: OrderRow, index: number, step: -1 | 1) => void;
}) {
	const heading = useId();
	const text = LIST[kind];
	return (
		<Card size="sm" as="section" aria-labelledby={heading}>
			<h3 id={heading} className="font-semibold text-ink">
				{text.title}
			</h3>
			<p className="text-sm text-text-3">{text.description}</p>
			{rows.length === 0 ? (
				<p className="mt-3 border-t border-line pt-3 text-text-2">{text.empty}</p>
			) : (
				<ol aria-labelledby={heading} className="mt-2 flex flex-col">
					{rows.map((row, index) => (
						<li key={row.id} className="flex items-center gap-3 border-t border-line py-2.5 first:border-t-0">
							<span aria-hidden="true" className="w-5 flex-none text-right text-sm text-text-3 tabular-nums">
								{index + 1}
							</span>
							<span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2.5 gap-y-1">
								<span className="min-w-0 font-medium break-words text-ink">{row.name}</span>
								{index === 0 ? (
									<StatusBadge status="positive" size="sm" fill="soft">
										Preferred
									</StatusBadge>
								) : null}
							</span>
							<span className="flex flex-none gap-1.5">
								{([-1, 1] as const).map((step) => {
									const edge = step === -1 ? index === 0 : index === rows.length - 1;
									const label = `Move ${row.name} ${step === -1 ? "up" : "down"}`;
									return (
										<Tooltip key={step} content={step === -1 ? "Move up" : "Move down"}>
											<IconButton
												size="sm"
												icon={step === -1 ? ArrowUp01Icon : ArrowDown01Icon}
												label={label}
												data-move={row.id}
												data-step={step}
												disabled={edge || disabled}
												onClick={() => onMove(kind, row, index, step)}
											/>
										</Tooltip>
									);
								})}
							</span>
						</li>
					))}
				</ol>
			)}
		</Card>
	);
}
