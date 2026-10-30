// A test fixture formal/legal document. None of the 11 templates is formal/legal, so the notice and the doctrinal
// slot are proven here, on the same shell and blocks the templates use. The fixture only declares its class (on ctx);
// the shared Footer prints the notice.
import { Page } from "@formepdf/react";
import { Footer, Title, type Ctx } from "../src/documents/layouts/blocks.tsx";
import { Doc, DoctrineSlot, LETTER, LETTER_MARGIN } from "../src/documents/layouts/shell.tsx";

export function legalFixture(ctx: Ctx) {
	const page = (
		<Page size={LETTER} margin={LETTER_MARGIN}>
			{Footer(ctx, "Harborlight Church  |  Statement of Faith", ctx.p.ink)}
			{Title(ctx, "Statement of Faith", ctx.p.ink, ctx.p.white, 28)}
			{DoctrineSlot(ctx, "Statement of faith")}
		</Page>
	);
	return Doc(ctx, "Statement of Faith", "Fixture", page);
}
