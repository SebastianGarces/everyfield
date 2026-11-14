import type { ProgramList } from "@everyfield/contracts/organizations";
import { Mortarboard02Icon, PlusSignIcon } from "@hugeicons/core-free-icons";
import { Button, EmptyState, PageHeader } from "@everyfield/ui/controls";
import Link from "next/link";
import { formatDay, plural } from "../board/model";
import { PipelineTabs } from "../board/PipelineTabs";
import { KIND, programHref, programStatus, PROGRAMS_PATH } from "./model";

/**
 * The Programs tab (REQ-MUL-010): the organization's apprenticeships and residencies with their director, status and
 * active enrollments, and Active residents (REQ-MUL-007). Owners and Admins start a new program here.
 */
export function ProgramsScreen({ list }: { list: ProgramList }) {
	const create = list.administrator ? (
		<Button asChild variant="primary" icon={PlusSignIcon}>
			<Link href={`${PROGRAMS_PATH}/new`}>New program</Link>
		</Button>
	) : null;
	return (
		<div className="flex min-w-0 flex-col">
			<PageHeader
				title="Pipeline"
				subtitle={`The people ${list.organizationName} is developing toward planting.`}
				actions={list.programs.length ? create : null}
			/>
			<PipelineTabs current="programs" />
			{list.programs.length === 0 ? (
				<EmptyState icon={Mortarboard02Icon} title="No programs yet" action={create} className="pt-2">
					{list.administrator
						? "Set up your apprenticeship or residency once, from the residency template or from blank. Then enroll the people you are developing and record the milestones each one finishes."
						: "Your Owner or an Admin sets up apprenticeships and residencies here."}
				</EmptyState>
			) : (
				<div className="flex flex-col gap-5">
					<section
						aria-label="Active residents"
						className="flex w-fit min-w-[220px] flex-col gap-1 rounded-card bg-surface-2 px-4 py-3.5"
					>
						<span className="text-sm font-semibold text-ink">Active residents</span>
						<span className="text-title-lg leading-none text-ink">{list.activeResidents}</span>
						<span className="text-xs text-text-3">People in a residency now. Apprenticeships don’t count.</span>
					</section>
					<ul className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3 max-app-sm:grid-cols-1">
						{list.programs.map((p) => (
							<li key={p.id}>
								<article className="relative flex h-full flex-col gap-2 rounded-card bg-surface-raised p-4 shadow-raised">
									<div className="flex items-start justify-between gap-3">
										<h2 className="min-w-0 font-body text-base font-semibold tracking-normal text-ink">
											<Link
												href={programHref(p.id)}
												className="cursor-pointer [overflow-wrap:anywhere] after:absolute after:inset-0 after:rounded-card hover:underline"
											>
												{p.name}
											</Link>
										</h2>
										<span className="flex-none rounded-full bg-surface-2 px-2.5 py-0.5 text-xs font-medium text-ink-2">
											{KIND[p.kind]}
										</span>
									</div>
									<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
										<dt className="text-text-2">Director</dt>
										<dd className="min-w-0 truncate text-ink">{p.director.name}</dd>
										<dt className="text-text-2">Status</dt>
										<dd className="min-w-0 text-ink">
											{programStatus(p)}
											{p.publishedOn ? <span className="text-text-3"> · {formatDay(p.publishedOn)}</span> : null}
										</dd>
										<dt className="text-text-2">Enrolled</dt>
										<dd className="text-ink">{plural(p.activeEnrollments, "active enrollment")}</dd>
									</dl>
								</article>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}
