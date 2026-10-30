// A test fixture formal/legal document. None of the 11 templates is formal/legal, so the notice and the doctrinal
// slot are proven here, on the same shell and blocks the templates use.
import { Page } from "@formepdf/react";
import { T, Title, type Ctx } from "../src/documents/layouts/blocks.tsx";
import { Doc, DoctrineSlot, LEGAL_NOTICE, LETTER } from "../src/documents/layouts/shell.tsx";

export function legalFixture(ctx: Ctx) {
	const page = (
		<Page size={LETTER} margin={40}>
			{Title(ctx, "Statement of Faith", ctx.p.ink, ctx.p.white, 28)}
			{T(ctx, LEGAL_NOTICE, { color: ctx.p.ink, use: "legal notice" })}
			{DoctrineSlot(ctx, "Statement of faith")}
		</Page>
	);
	return Doc(ctx, "Statement of Faith", "Fixture", page);
}
