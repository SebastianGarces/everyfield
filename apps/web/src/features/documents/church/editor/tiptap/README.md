# Tiptap's free UI components, copied

These files come from Tiptap's free, MIT-licensed UI component repository
(https://github.com/ueberdosis/tiptap-ui-components, license: https://github.com/ueberdosis/tiptap-ui-components/blob/main/LICENSE).
It is the source of the free `simple-editor` template (https://tiptap.dev/docs/ui-components/templates/simple-editor).
Source commit: `799929bea4804c73767562b69f8acc2acdb8ac86` (main, 2025-10-07). Nothing here comes from a paid plan:
no `@tiptap-pro/*` package, no Start-plan component such as the slash dropdown menu, no registry token. A test
(`tests/ui/documents/editor-schema.test.mts`) fails on any non-MIT `@tiptap/*` package, any `@tiptap-pro/*` package and any
Tiptap registry line in an `.npmrc`.

Every copied file keeps Tiptap's code. The changes are the same few in each: imports point to this folder, the SCSS
imports are gone and the class names are Tailwind strings from `styles.ts` (made of `packages/ui` tokens), the
`@radix-ui/*` imports read the `radix-ui` package the app already uses, and Tiptap's SVG icons are the product's
Hugeicons (`icons.tsx`). Extra changes are listed per file.

| File here | Source in `apps/web/src/` of the Tiptap repository | Extra change |
|---|---|---|
| `primitives/button.tsx` | `components/tiptap-ui-primitive/button/button.tsx` | none |
| `primitives/tooltip.tsx` | `components/tiptap-ui-primitive/tooltip/tooltip.tsx` | none |
| `primitives/popover.tsx` | `components/tiptap-ui-primitive/popover/popover.tsx` | none |
| `primitives/dropdown-menu.tsx` | `components/tiptap-ui-primitive/dropdown-menu/dropdown-menu.tsx` | only the parts the toolbar uses (no sub, group or radio menus) |
| `primitives/toolbar.tsx` | `components/tiptap-ui-primitive/toolbar/toolbar.tsx` | toolbar name "Document formatting" |
| `primitives/separator.tsx` | `components/tiptap-ui-primitive/separator/separator.tsx` | none |
| `primitives/input.tsx` | `components/tiptap-ui-primitive/input/input.tsx` | none |
| `ui/mark-button.tsx`, `ui/use-mark.ts` | `components/tiptap-ui/mark-button/` | only bold, italic and underline; shortcut badge is a `kbd`; visibility is derived on each render, not set in an effect |
| `ui/undo-redo-button.tsx`, `ui/use-undo-redo.ts` | `components/tiptap-ui/undo-redo-button/` | shortcut badge is a `kbd` |
| `ui/list-button.tsx`, `ui/use-list.ts` | `components/tiptap-ui/list-button/` | only bullet and ordered lists (the format has no task list); the toggle is one chain so one Undo reverts it; shortcut badge is a `kbd` |
| `ui/blockquote-button.tsx`, `ui/use-blockquote.ts` | `components/tiptap-ui/blockquote-button/` | the node is `quote`; the toggle is one chain so one Undo reverts it; shortcut badge is a `kbd` |
| `ui/link-popover.tsx`, `ui/use-link-popover.ts` | `components/tiptap-ui/link-popover/` | links must start with `https://`, `http://` or `mailto:` and a refusal shows a message; editing the link under the cursor does not insert its address as text; visibility is derived on each render, not set in an effect; the card wrapper is a plain `div` |
| `use-tiptap-editor.ts` | `hooks/use-tiptap-editor.ts` | none |
| `use-composed-ref.ts` | `hooks/use-composed-ref.ts` | none |
| `use-menu-navigation.ts` | `hooks/use-menu-navigation.ts` | none |
| `use-mobile.ts` | `hooks/use-mobile.ts` | none |
| `tiptap-utils.ts` | `lib/tiptap-utils.ts` | only the functions the copied files use |

Full URL of a source file: `https://github.com/ueberdosis/tiptap-ui-components/blob/799929bea4804c73767562b69f8acc2acdb8ac86/apps/web/src/<path>`.

Tiptap has no free ready-made component for the combined text-style menu (paragraph styles and headings in one
menu), the tag label, the block insert menu or the move and delete controls. `../Toolbar.tsx` builds those from the
same primitives (button, dropdown menu, toolbar). The lists and the quote use Tiptap's ready-made buttons.
