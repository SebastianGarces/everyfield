import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";

const MAC_SYMBOLS: Record<string, string> = {
	mod: "⌘",
	command: "⌘",
	meta: "⌘",
	ctrl: "⌃",
	control: "⌃",
	alt: "⌥",
	option: "⌥",
	shift: "⇧",
	backspace: "Del",
	delete: "⌦",
	enter: "⏎",
	escape: "⎋",
	capslock: "⇪",
} as const;

export function cn(...classes: (string | boolean | undefined | null)[]): string {
	return classes.filter(Boolean).join(" ");
}

function isMac(): boolean {
	return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

const formatShortcutKey = (key: string, isMac: boolean, capitalize: boolean = true) => {
	if (isMac) {
		const lowerKey = key.toLowerCase();
		return MAC_SYMBOLS[lowerKey] || (capitalize ? key.toUpperCase() : key);
	}

	const shown = key.toLowerCase() === "mod" ? "ctrl" : key;
	return capitalize ? shown.charAt(0).toUpperCase() + shown.slice(1) : shown;
};

export const parseShortcutKeys = (props: {
	shortcutKeys: string | undefined;
	delimiter?: string;
	capitalize?: boolean;
}) => {
	const { shortcutKeys, delimiter = "+", capitalize = true } = props;

	if (!shortcutKeys) return [];

	return shortcutKeys
		.split(delimiter)
		.map((key) => key.trim())
		.map((key) => formatShortcutKey(key, isMac(), capitalize));
};

export const isMarkInSchema = (markName: string, editor: Editor | null): boolean => {
	if (!editor?.schema) return false;
	return editor.schema.spec.marks.get(markName) !== undefined;
};

export function isNodeTypeSelected(editor: Editor | null, types: string[] = []): boolean {
	if (!editor || !editor.state.selection) return false;

	const { state } = editor;
	const { selection } = state;

	if (selection.empty) return false;

	if (selection instanceof NodeSelection) {
		const node = selection.node;
		return node ? types.includes(node.type.name) : false;
	}

	return false;
}

type ProtocolOptions = {
	scheme: string;

	optionalSlashes?: boolean;
};

type ProtocolConfig = Array<ProtocolOptions | string>;

const ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

function isAllowedUri(uri: string | undefined, protocols?: ProtocolConfig) {
	const allowedProtocols: string[] = ["http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp"];

	if (protocols) {
		protocols.forEach((protocol) => {
			const nextProtocol = typeof protocol === "string" ? protocol : protocol.scheme;

			if (nextProtocol) {
				allowedProtocols.push(nextProtocol);
			}
		});
	}

	return (
		!uri ||
		uri
			.replace(ATTR_WHITESPACE, "")
			.match(new RegExp(`^(?:(?:${allowedProtocols.join("|")}):|[^a-z]|[a-z0-9+.\-]+(?:[^a-z+.\-:]|$))`, "i"))
	);
}

export function sanitizeUrl(inputUrl: string, baseUrl: string, protocols?: ProtocolConfig): string {
	try {
		const url = new URL(inputUrl, baseUrl);

		if (isAllowedUri(url.href, protocols)) {
			return url.href;
		}
	} catch {}
	return "#";
}

export const isNodeInSchema = (nodeName: string, editor: Editor | null): boolean => {
	if (!editor?.schema) return false;
	return editor.schema.spec.nodes.get(nodeName) !== undefined;
};
