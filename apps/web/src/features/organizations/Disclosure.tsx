import { StatusBadge } from "@everyfield/ui/display";
import { CATEGORIES, CATEGORY_TEXT, NEVER_SHARED } from "./model";
import { PrivateLine } from "./parts";
import type { Choices, Disclosure } from "./port";

const HEADING: Record<Disclosure["kind"], (name: string) => { title: string; text: string }> = {
	first_invitation: (name) => ({
		title: `What ${name} can see once connected`,
		text: `Every category starts on for ${name} only. You can turn any of them off at any time in Sharing and privacy.`,
	}),
	existing_consent: (name) => ({
		title: `Your earlier choices for ${name} come back`,
		text: `Your church was connected with ${name} before. Connecting again keeps what you chose then.`,
	}),
	self_start: (name) => ({
		title: `Nothing is shared with ${name} yet`,
		text: "Every category starts off. Turn on what you want to share in Sharing and privacy.",
	}),
};

export function SharingDisclosure({
	disclosure,
	organizationName,
}: {
	disclosure: Disclosure;
	organizationName: string;
}) {
	const { title, text } = HEADING[disclosure.kind](organizationName);
	return (
		<section aria-label={title} className="rounded-lg bg-surface px-5 py-4">
			<h3 className="font-semibold text-ink">{title}</h3>
			<p className="mt-1 text-sm text-text-3">{text}</p>
			<ChoiceList choices={disclosure.choices} />
			<PrivateLine>{NEVER_SHARED}</PrivateLine>
		</section>
	);
}

function ChoiceList({ choices }: { choices: Choices }) {
	return (
		<ul className="mt-3 flex flex-col">
			{CATEGORIES.map((category) => (
				<li key={category} className="flex items-center gap-3 border-t border-line py-2 first:border-t-0">
					<span className="min-w-0 flex-1 text-sm text-ink">{CATEGORY_TEXT[category].label}</span>
					<StatusBadge status={choices[category] ? "positive" : "unknown"} size="sm" fill="soft" plain>
						{choices[category] ? "Shared" : "Not shared"}
					</StatusBadge>
				</li>
			))}
		</ul>
	);
}
