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
import { useEffect, useState } from "react";
import type { Locality, RegionRead, RegionSuggestion } from "../port";
import { newRequestKey } from "../port";
import { SaveError } from "../SettingsDialog";
import { useSettings } from "../store";

// The church's reporting Region (WP-047b, REQ-PI-044): an official OMB 23-01 metro or micro area. The planter types
// their city and state; the official list suggests the area that names it as a principal city. A place several areas
// match is never resolved for them: they choose, or leave it unresolved. Sending churches and networks see the city,
// state and Region, never the street, and cannot set or change it.

type Ready = Extract<RegionRead, { status: "ok" }>;
const UNRESOLVED = "unresolved";

/** The Region row of the church settings: the saved area and, for an Owner or Admin, the picker. */
export function ReportingRegion({ onSaved }: { onSaved: () => void }) {
	const { port } = useSettings();
	const [read, setRead] = useState<RegionRead | null>(null);
	const [session, setSession] = useState(0);
	const [open, setOpen] = useState(false);
	useEffect(() => {
		let live = true;
		void port.region.read().then((r) => live && setRead(r));
		return () => {
			live = false;
		};
	}, [port, session]);

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
				<Button size="sm" variant="secondary" onClick={() => setOpen(true)} disabled={!read.referenceVersionId}>
					{read.region ? "Change Region" : "Choose Region"}
				</Button>
			) : (
				<span className="text-sm text-text-3">Owners and Admins can change it.</span>
			)}
			{open ? (
				<RegionDialog
					key={session}
					read={read}
					onClose={() => setOpen(false)}
					onSaved={() => {
						setOpen(false);
						setRead(null);
						setSession((n) => n + 1);
						onSaved();
					}}
				/>
			) : null}
		</div>
	);
}

function RegionDialog({ read, onClose, onSaved }: { read: Ready; onClose: () => void; onSaved: () => void }) {
	const { port } = useSettings();
	const [place, setPlace] = useState<Locality>(read.locality);
	const [found, setFound] = useState<RegionSuggestion[] | null>(null);
	const [choice, setChoice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [key] = useState(() => newRequestKey("region"));

	const find = async (where: Locality) => {
		setProblem(null);
		const r = await port.region.suggest(where);
		if (!r) return setProblem("We couldn't look up areas. Try again in a moment.");
		setFound(r);
		// One official match is suggested; several are never chosen for the planter.
		setChoice(
			r.length === 1
				? r[0]!.regionItemId
				: r.length === 0
					? UNRESOLVED
					: (r.find((c) => c.area.code === read.region?.code)?.regionItemId ?? null),
		);
	};
	useEffect(() => {
		void find(read.locality);
		// Look up the saved place once when the dialog opens.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const set = (k: keyof Locality) => (e: React.ChangeEvent<HTMLInputElement>) => {
		setPlace({ ...place, [k]: e.target.value });
		setFound(null);
		setChoice(null);
	};
	const save = async () => {
		if (!choice || !read.referenceVersionId) return;
		setBusy(true);
		const r = await port.region.save({
			requestKey: key,
			expectedRevision: read.revision,
			locality: place,
			referenceVersionId: read.referenceVersionId,
			regionItemId: choice === UNRESOLVED ? null : choice,
		});
		setBusy(false);
		if (r.status === "ok") return onSaved();
		setProblem(
			r.status === "conflict"
				? "Your church's settings changed since you opened this. Close it and try again."
				: "The Region wasn't saved. Only Owners and Admins can change it, and only to an area the list offers.",
		);
	};

	return (
		<Dialog open onOpenChange={(o) => (o ? null : onClose())}>
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
						<Button size="sm" variant="secondary" onClick={() => void find(place)}>
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
							<RadioGroup aria-label="Reporting Region" value={choice ?? ""} onValueChange={setChoice}>
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
					{problem ? <SaveError message={problem} /> : null}
				</DialogBody>
				<DialogFooter>
					<Button variant="secondary" onClick={onClose}>
						Cancel
					</Button>
					<Button variant="primary" onClick={() => void save()} disabled={!choice || busy}>
						{busy ? "Saving…" : "Save Region"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
