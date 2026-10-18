"use client";

import { ComputerIcon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { useState } from "react";
import { SegmentedControl } from "../../controls";
import {
	EmailButton,
	EmailButtons,
	EmailHeading,
	EmailLayout,
	EmailList,
	EmailMeta,
	EmailNote,
	EmailSignature,
	EmailStats,
	EmailText,
} from "..";
import { Section } from "./kit";

const CHURCH_FOOTER = {
	reason: "You get this email because you are part of Harvest Point Church.",
	address: "Harvest Point Church · 2201 Hyde Park Ave, Austin, TX 78705",
	preferencesHref: "#preferences",
	unsubscribeHref: "#unsubscribe",
};
const EF_FOOTER = {
	reason: "You get this weekly digest because it is on in your notification settings.",
	address: "Everyfield · church planting, one step at a time",
	preferencesHref: "#preferences",
	unsubscribeHref: "#unsubscribe",
};

export function EmailSection({ index }: { index: number }) {
	const [width, setWidth] = useState<"desktop" | "phone">("desktop");
	return (
		<Section
			index={index}
			title="Email"
			code="<EmailLayout from width> <EmailHeading> <EmailText> <EmailButtons> <EmailMeta> <EmailList> <EmailStats> <EmailSignature> <EmailNote>"
			note="What people receive, drawn inside the product. Emails always use the light palette and a 600px column, also in dark mode. Church emails show the church name; system emails show Everyfield."
		>
			<SegmentedControl
				label="Email width"
				className="mb-4"
				value={width}
				onValueChange={setWidth}
				options={[
					{ value: "desktop", label: "Desktop 600", icon: ComputerIcon },
					{ value: "phone", label: "Phone 375", icon: SmartPhone01Icon },
				]}
			/>
			<div className="flex flex-col gap-6 rounded-[24px] bg-canvas p-7 max-app-sm:p-3">
				<EmailLayout
					width={width}
					from={{ kind: "church", name: "Harvest Point Church" }}
					envelope={{
						from: "Daniel at Harvest Point <daniel@example.org>",
						to: "maria@example.org",
						subject: "You're invited: Vision meeting, Sun Oct 12",
					}}
					footer={CHURCH_FOOTER}
				>
					<EmailHeading>Maria, come and hear why we are planting in Hyde Park</EmailHeading>
					<EmailText>
						We are gathering a few friends for dinner and a short story about the church we hope to start. Kids are
						welcome; we have childcare.
					</EmailText>
					<EmailMeta
						rows={[
							{ label: "When", value: "Sunday, October 12 · 6:30 to 8 pm" },
							{ label: "Where", value: "The Reyes home, 4410 Avenue F" },
							{ label: "Host", value: "Daniel and Ana" },
						]}
					/>
					<EmailText>
						<b>Can you come?</b>
					</EmailText>
					<EmailButtons>
						<EmailButton href="#yes" variant="yes">
							Yes, I&apos;ll come
						</EmailButton>
						<EmailButton href="#maybe" variant="alt">
							Maybe
						</EmailButton>
						<EmailButton href="#no" variant="alt">
							Can&apos;t make it
						</EmailButton>
					</EmailButtons>
					<EmailSignature name="Daniel Reyes" role="Lead planter, Harvest Point Church" />
				</EmailLayout>
				<EmailLayout
					width={width}
					from={{ kind: "everyfield" }}
					envelope={{
						from: "Everyfield <digest@everyfield.app>",
						to: "daniel@example.org",
						subject: "Your week at Harvest Point: +2 committed, 1 meeting",
					}}
					footer={EF_FOOTER}
				>
					<EmailText small>Week of October 6 · Phase 1</EmailText>
					<EmailHeading>Your week at Harvest Point</EmailHeading>
					<EmailStats
						stats={[
							{ value: "34", label: "core group · +2" },
							{ value: "38", label: "RSVPs for Sunday" },
							{ value: "3", label: "follow-ups overdue" },
						]}
					/>
					<EmailList
						items={[
							{ badge: "KW", text: "Kim Wu · no owner", tag: "22 h late" },
							{ badge: "12", text: "Vision meeting #12 · Sun Oct 12, 6:30 pm", tone: "green" },
							{ badge: "15", text: "Worship team training · Wed Oct 15", tone: "violet" },
						]}
					/>
					<EmailNote>
						<b>Evry noticed:</b> guests called within 48 hours came back twice as often this month.
					</EmailNote>
					<EmailButtons>
						<EmailButton href="#open">Open Harvest Point</EmailButton>
					</EmailButtons>
				</EmailLayout>
			</div>
		</Section>
	);
}
