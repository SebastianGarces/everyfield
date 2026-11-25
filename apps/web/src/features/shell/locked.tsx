import { START_CHURCH } from "@everyfield/contracts/identity";
import { ChurchIcon } from "@hugeicons/core-free-icons";
import { Button, PageState } from "@everyfield/ui/controls";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { getViewer } from "../../server/request-context.ts";

type Locked = { children: ReactNode };

async function discoveryLock(page: string, title: string, what: string, children: ReactNode) {
	if (!(await getViewer()).discovery) return children;
	return (
		<PageState
			page={page}
			icon={ChurchIcon}
			title={title}
			actions={
				<Button asChild variant="primary">
					<Link href={START_CHURCH}>Start a church</Link>
				</Button>
			}
		>
			{what} You can keep exploring in Discovery for as long as you need.
		</PageState>
	);
}

export const PeopleLock = ({ children }: Locked) =>
	discoveryLock(
		"People",
		"People opens when you start your church",
		"This is where your church keeps track of the people it reaches.",
		children,
	);
export const MeetingsLock = ({ children }: Locked) =>
	discoveryLock(
		"Meetings",
		"Meetings opens when you start your church",
		"This is where your church plans its gatherings and records who came.",
		children,
	);
export const TasksLock = ({ children }: Locked) =>
	discoveryLock(
		"Tasks",
		"Tasks opens when you start your church",
		"This is where your church team shares its work and follow-ups.",
		children,
	);
export const LaunchLock = ({ children }: Locked) =>
	discoveryLock(
		"Launch",
		"Launch opens when you start your church",
		"This is where your church plans its launch.",
		children,
	);
export const MinistriesLock = ({ children }: Locked) =>
	discoveryLock(
		"Ministries",
		"Ministries opens when you start your church",
		"This is where your church organizes its teams and the people who serve.",
		children,
	);
export const MessagesLock = ({ children }: Locked) =>
	discoveryLock(
		"Messages",
		"Messages opens when you start your church",
		"This is where your church sends email to the people it reaches.",
		children,
	);
export const IntelligenceLock = ({ children }: Locked) =>
	discoveryLock(
		"Plant Intelligence",
		"Plant Intelligence opens when you start your church",
		"This is where your church sees how it is growing, phase by phase.",
		children,
	);

async function redirectDiscovery(to: string, children: ReactNode) {
	if ((await getViewer()).discovery) redirect(to);
	return children;
}

export const MeetingPagesLock = ({ children }: Locked) => redirectDiscovery("/meetings", children);
export const ChurchDocumentsLock = ({ children }: Locked) => redirectDiscovery("/documents", children);
