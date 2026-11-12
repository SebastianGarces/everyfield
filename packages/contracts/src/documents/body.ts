import { z } from "zod";

/** One block of text, or one list item. */
const BLOCK_TEXT_MAX = 20_000;
/** The JSON of one body. The export limit is 8 MiB of output. */
export const BODY_JSON_MAX = 2_000_000;
const LIST_ITEMS_MAX = 200;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Text the renderers print. No NUL, no lone surrogate. */
const printable = z
	.string()
	.max(BLOCK_TEXT_MAX)
	.refine((value) => !value.includes("\0") && !LONE_SURROGATE.test(value), "Text holds a character that cannot print.");

const slotId = z
	.string()
	.min(1)
	.max(60)
	.regex(/^[a-z][a-z0-9-]*$/);

const textBlock = <K extends string>(kind: K) => z.strictObject({ kind: z.literal(kind), text: printable });
const listBlock = <K extends string>(kind: K) =>
	z.strictObject({ kind: z.literal(kind), items: z.array(printable).min(1).max(LIST_ITEMS_MAX) });

/**
 * The Wiki safe-editor kinds plus the doctrinal slot node. The slot id is stable. The slot label comes from the
 * template, so the body never stores it. The legal notice, the letterhead and the signature block are not body
 * nodes: export renders them from the template frame.
 */
export const churchBlock = z.discriminatedUnion("kind", [
	textBlock("heading"),
	textBlock("subheading"),
	textBlock("paragraph"),
	textBlock("quote"),
	listBlock("bulleted_list"),
	listBlock("numbered_list"),
	z.strictObject({ kind: z.literal("slot"), slotId, text: printable }),
]);
export type ChurchBlock = z.infer<typeof churchBlock>;
