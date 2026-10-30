import { Page, TextField } from "@formepdf/react";
import { SIZE, SP } from "../theme.ts";
import {
	CHECKLIST_INSTRUCTION,
	CHECKLIST_TEAMS,
	CHECKLIST_TITLE,
	type ChecklistTeam,
} from "../templates/checklists-content.ts";
import {
	Box,
	Cellfield,
	Cellt,
	DataTable,
	Field,
	Footer,
	LogoSlot,
	SectionHead,
	T,
	Title,
	View,
	type Ctx,
} from "./blocks.tsx";
import { Doc, LETTER } from "./shell.tsx";

const margin = { top: 40, right: 40, bottom: 56, left: 40 };

function teamBlock(ctx: Ctx, team: ChecklistTeam, n: number) {
	const { p } = ctx;
	const rows = team.tasks.map((task, i) => [
		<View key="b" style={{ alignItems: "center" }}>
			{Box(ctx, `${team.id}_${i + 1}_done`, 13)}
		</View>,
		Cellt(ctx, task, { use: "task text", bg: i % 2 ? p.muted : p.white }),
		Cellfield(`${team.id}_${i + 1}_owner`, 100, 14),
		Cellfield(`${team.id}_${i + 1}_time`, 52, 14),
	]);
	return (
		<View key={team.id} wrap={false} style={{ marginTop: SP[4] }}>
			{SectionHead(
				ctx,
				n,
				team.name,
				"fill",
				<View style={{ flexDirection: "row", alignItems: "center", gap: SP[2] }}>
					{T(ctx, "Team lead", { size: SIZE.xs, weight: 700, color: p.mutedText, use: "team lead label", caps: true })}
					<TextField name={`${team.id}_lead`} width={130} height={16} fontSize={SIZE.sm} />
				</View>,
			)}
			{DataTable(
				ctx,
				[
					{ label: "Done", w: 38, align: "center" },
					{ label: "Task", w: "auto" },
					{ label: "Owner", w: 116 },
					{ label: "Time", w: 68 },
				],
				rows,
				{ headFill: p.accent, headText: p.onAccent, use: "checklist", rowMin: 21, zebra: true },
			)}
		</View>
	);
}
/** Two Letter pages: the title block and three teams, then a running header and three teams. */
export function checklistsDocument(ctx: Ctx) {
	const { p, theme } = ctx;
	const l = theme.letterhead;
	const date = ctx.values.launch_date;
	const foot = `${l?.legalName ?? ctx.church}  |  Launch Sunday checklists${date ? `  |  ${date}` : ""}`;
	const [first, second] = [CHECKLIST_TEAMS.slice(0, 3), CHECKLIST_TEAMS.slice(3)];
	const page1 = (
		<Page size={LETTER} margin={margin}>
			{Footer(ctx, foot, p.ink)}
			<View style={{ flexDirection: "row", alignItems: "center", height: 28 }}>
				{LogoSlot(ctx, theme.logo ? 150 : 200, 28, theme.logo)}
				<View style={{ flexGrow: 1, alignItems: "flex-end" }}>
					{T(ctx, "Team checklists", {
						size: SIZE.xs,
						weight: 700,
						color: p.mutedText,
						use: "page kicker",
						caps: true,
					})}
				</View>
			</View>
			<View style={{ borderBottomWidth: 4, borderColor: p.accent, marginTop: SP[2], marginBottom: SP[3] }} />
			{Title(ctx, CHECKLIST_TITLE, p.ink, p.white, 28, "checklist title")}
			<View style={{ marginTop: 2, marginBottom: 2 }}>
				{date ? (
					T(ctx, `Launch Sunday  ·  ${date}`, {
						size: SIZE.base,
						color: p.mutedText,
						use: "launch date line",
						figures: true,
					})
				) : (
					<View style={{ flexDirection: "row", alignItems: "flex-end", gap: SP[2] }}>
						{Field(ctx, "Launch Sunday date", 170, 17, { name: "launch_date" })}
					</View>
				)}
			</View>
			{T(ctx, CHECKLIST_INSTRUCTION, {
				size: SIZE.base,
				color: p.ink,
				use: "checklist instruction",
				style: { marginTop: SP[1] },
			})}
			{first.map((team, i) => teamBlock(ctx, team, i + 1))}
		</Page>
	);
	const page2 = (
		<Page size={LETTER} margin={margin}>
			{Footer(ctx, foot, p.ink)}
			<View
				style={{
					flexDirection: "row",
					justifyContent: "space-between",
					alignItems: "center",
					borderBottomWidth: 1,
					borderColor: p.ink,
					paddingBottom: SP[1],
				}}
			>
				{T(ctx, `${CHECKLIST_TITLE}, continued`, { size: SIZE.sm, weight: 700, color: p.ink, use: "running header" })}
				{T(ctx, ctx.church, {
					size: SIZE.xs,
					weight: 700,
					color: p.mutedText,
					use: "running header church",
					caps: true,
				})}
			</View>
			{second.map((team, i) => teamBlock(ctx, team, i + 4))}
		</Page>
	);
	return Doc(
		ctx,
		`${CHECKLIST_TITLE}, ${ctx.church}`,
		"Six team checklists for launch day",
		<>
			{page1}
			{page2}
		</>,
	);
}
