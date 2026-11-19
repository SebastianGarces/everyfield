"use client";

import { regionLabel } from "@everyfield/contracts/oversight";
import { MapsLocation01Icon } from "@hugeicons/core-free-icons";
import {
	Button,
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	Field,
	Input,
	Radio,
	RadioGroup,
	Skeleton,
} from "@everyfield/ui/controls";
import { useRef, useState, useTransition } from "react";
import { useRead } from "../../../components/read.tsx";
import type { Locality, RegionRead, RegionSuggestion } from "../port";
import { newRequestKey } from "../port";
import { SaveError } from "../SaveError";
import { useReads, useSettings } from "../store";

type Ready = Extract<RegionRead, { status: "ok" }>;
const UNRESOLVED = "unresolved";

const SAVE_PROBLEM = {
	conflict: "Your church's settings changed since you opened this. Close it and try again.",
	refused: "The Region wasn't saved. Only Owners and Admins can change it, and only to an area the list offers.",
	lost: "Everyfield could not be reached, so the Region may not have saved. Close this and check the Region shown.",
} as const;

export function ReportingRegion({ onSaved }: { onSaved: () => void }) {
	const reads = useReads();
	const region = useRead(reads.region);
	const [openWith, setOpenWith] = useState<string | null>(null);
	const read = region.value;

	if (!read) return <Skeleton shape="block" height={44} />;
	if (read.status !== "ok")
		return (
			<p className="text-md text-text-2">
				{read.status === "denied" ? "Only this church's seats can see its Region." : "The Region couldn't load."}
			</p>
		);
	return (
		<div className="flex flex-wrap items-center gap-3">
			<span className={read.region ? "font-medium text-ink" : "text-text-3"} data-region={read.region?.code ?? ""}>
				{read.region ? regionLabel(read.region) : "Not set"}
			</span>
			{read.canEdit ? (
				<Button
					size="sm"
					variant="secondary"
					onClick={() => {
						reads.regionMatches.prefetch(read.locality);
						setOpenWith(newRequestKey("region"));
					}}
					disabled={!read.referenceVersionId}
				>
					{read.region ? "Change Region" : "Choose Region"}
				</Button>
			) : (
				<span className="text-sm text-text-3">Owners and Admins can change it.</span>
			)}
			{openWith ? (
				<RegionDialog
					key={openWith}
					requestKey={openWith}
					read={read}
					onClose={() => setOpenWith(null)}
					onSaved={() => {
						setOpenWith(null);
						region.retry();
						onSaved();
					}}
				/>
			) : null}
		</div>
	);
}

function suggestedChoice(found: RegionSuggestion[], saved: Ready["region"]): string | null {
	if (found.length === 1) return found[0]!.regionItemId;
	if (found.length === 0) return UNRESOLVED;
	return found.find((c) => c.area.code === saved?.code)?.regionItemId ?? null;
}

function RegionDialog({
	requestKey,
	read,
	onClose,
	onSaved,
}: {
	requestKey: string;
	read: Ready;
	onClose: () => void;
	onSaved: () => void;
}) {
	const { port } = useSettings();
	const reads = useReads();
	const [place, setPlace] = useState<Locality>(read.locality);
	const [asked, setAsked] = useState<Locality | null>(read.locality);
	const [choice, setChoice] = useState<string | null | undefined>(undefined);
	const [problem, setProblem] = useState<string | null>(null);
	const [busy, startSave] = useTransition();
	const lookup = useRef<Promise<unknown> | null>(null);
	const matches = useRead(asked ? reads.regionMatches : null, asked ?? read.locality);
	const found = asked && matches.value ? matches.value : null;
	const lookupFailed = asked !== null && matches.status === "ready" && matches.value === null;
	const chosen = found ? (choice === undefined ? suggestedChoice(found, read.region) : choice) : null;

	const find = () => {
		setProblem(null);
		setChoice(undefined);
		if (asked) {
			const shown = matches.value;
			const answer = reads.regionMatches.refresh(asked);
			lookup.current = answer;
			void answer.then((next) => {
				if (lookup.current !== answer || next !== null || !shown) return;
				reads.regionMatches.patch(() => shown, asked);
				setProblem("We couldn't look up areas. Try again in a moment.");
			});
		} else {
			lookup.current = null;
			reads.regionMatches.prefetch(place);
			setAsked(place);
		}
	};
	const set = (k: keyof Locality) => (e: React.ChangeEvent<HTMLInputElement>) => {
		lookup.current = null;
		setPlace({ ...place, [k]: e.target.value });
		setAsked(null);
		setChoice(undefined);
	};
	const save = () => {
		const referenceVersionId = read.referenceVersionId;
		if (!chosen || !referenceVersionId) return;
		startSave(async () => {
			const r = await port.region
				.save({
					requestKey,
					expectedRevision: read.revision,
					locality: place,
					referenceVersionId,
					regionItemId: chosen === UNRESOLVED ? null : chosen,
				})
				.catch(() => ({ status: "lost" }) as const);
			if (r.status === "ok") return onSaved();
			setProblem(SAVE_PROBLEM[r.status]);
		});
	};

	return (
		<Dialog drawer open onOpenChange={(o) => (o ? null : onClose())}>
			<DialogContent size="md">
				<DialogHeader
					icon={MapsLocation01Icon}
					tone="green"
					title="Reporting Region"
					description="The official US metro or micro area your church is in (OMB, July 2023). Sending churches and networks you share with see your city, state and Region, never your street."
				/>
				<DialogBody>
					<div className="grid grid-cols-3 gap-3 max-app-sm:grid-cols-1">
						<Field label="City">
							<Input value={place.city ?? ""} onChange={set("city")} autoComplete="address-level2" />
						</Field>
						<Field label="State">
							<Input value={place.stateProvince ?? ""} onChange={set("stateProvince")} autoComplete="address-level1" />
						</Field>
						<Field label="Country">
							<Input value={place.country ?? ""} onChange={set("country")} autoComplete="country-name" />
						</Field>
					</div>
					<div className="mt-3">
						<Button size="sm" variant="secondary" onClick={find}>
							Find areas
						</Button>
					</div>
					{found ? (
						<div className="mt-4" data-matches={found.length}>
							<p className="mb-1 text-md text-text-2 text-pretty">
								{found.length === 1
									? "Suggested from the official list:"
									: found.length > 1
										? "This place matches more than one area. Choose the one your church is in."
										: "No official area lists this place as a principal city. You can leave the Region unresolved."}
							</p>
							<RadioGroup aria-label="Reporting Region" value={chosen ?? ""} onValueChange={setChoice}>
								{found.map((c) => (
									<Radio key={c.regionItemId} value={c.regionItemId} label={regionLabel(c.area)} />
								))}
								<Radio
									value={UNRESOLVED}
									label="Leave unresolved"
									description="Your church still counts at the state, country and whole-portfolio levels."
								/>
							</RadioGroup>
						</div>
					) : null}
					{problem || lookupFailed ? (
						<SaveError message={problem ?? "We couldn't look up areas. Try again in a moment."} />
					) : null}
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" onClick={save} disabled={!chosen || busy}>
						{busy ? "Saving…" : "Save Region"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
