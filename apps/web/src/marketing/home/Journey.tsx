import { Display } from "@/components/Display";
import { Icon } from "@/components/Icon";
import { COPY } from "../copy";
import { ICONS } from "../icons";
import { Backdrop } from "../photo/Backdrop";
import { JourneyPath } from "./journey-fx";

/**
 * "Reach, gather, follow up, commit." (OPS-82): the four week steps and two Plant Intelligence steps on one path of six
 * stops over the field photo. EvryBot walks the path and says one line at each stop; the six cards below say what each
 * stop is. #intelligence lands here too. The markup renders here; journey-fx.tsx moves the walker.
 */
export function JourneySection() {
	const W = COPY.shared.week,
		J = COPY.shared.ops82.journey;
	const steps = [...W.steps, ...J.steps].map((s, i) => ({
		title: s.title,
		body: s.body,
		say: J.says[i]!,
		icon: <Icon icon={ICONS[J.icons[i]!]} size={40} stroke={1.4} className="size-[44%]" />,
	}));
	// The first sentence of the note is bold.
	const [, lead = "", rest = ""] = /^([^.]+\.)(.*)$/s.exec(J.see_first) ?? [];
	return (
		<JourneyPath
			label={W.title}
			steps={steps}
			head={
				<>
					<span id="intelligence" />
					<div className="mb-[clamp(28px,4vw,48px)]">
						<Display as="h2" size="h2" id="week-title" className="max-w-[18ch]">
							{W.title}
						</Display>
					</div>
				</>
			}
			photo={<Backdrop bg="field" sizes="(max-width: 1440px) 100vw, 1440px" className="absolute inset-0 -z-1" />}
			note={
				<p className="mt-[22px] flex items-start gap-2.5 type-lg leading-[1.5] text-text-2">
					<Icon icon={ICONS.lock} className="mt-[3px] text-ink" />
					<span>
						<b className="font-semibold text-ink">{lead}</b>
						{rest}
					</span>
				</p>
			}
		/>
	);
}
