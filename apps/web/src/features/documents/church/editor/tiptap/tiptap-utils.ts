import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";

export const MAC_SYMBOLS: Record<string, string> = {
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

/**
 * Determines if the current platform is macOS
 * @returns boolean indicating if the current platform is Mac
 */
export function isMac(): boolean {
	return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

/**
 * Formats a shortcut key based on the platform (Mac or non-Mac)
 * @param key - The key to format (e.g., "ctrl", "alt", "shift")
 * @param isMac - Boolean indicating if the platform is Mac
 * @param capitalize - Whether to capitalize the key (default: true)
 * @returns Formatted shortcut key symbol
 */
export const formatShortcutKey = (key: string, isMac: boolean, capitalize: boolean = true) => {
	if (isMac) {
		const lowerKey = key.toLowerCase();
		return MAC_SYMBOLS[lowerKey] || (capitalize ? key.toUpperCase() : key);
	}

	return capitalize ? key.charAt(0).toUpperCase() + key.slice(1) : key;
};

/**
 * Parses a shortcut key string into an array of formatted key symbols
 * @param shortcutKeys - The string of shortcut keys (e.g., "ctrl-alt-shift")
 * @param delimiter - The delimiter used to split the keys (default: "-")
 * @param capitalize - Whether to capitalize the keys (default: true)
 * @returns Array of formatted shortcut key symbols
 */
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

/**
 * Checks if a mark exists in the editor schema
 * @param markName - The name of the mark to check
 * @param editor - The editor instance
 * @returns boolean indicating if the mark exists in the schema
 */
export const isMarkInSchema = (markName: string, editor: Editor | null): boolean => {
	if (!editor?.schema) return false;
	return editor.schema.spec.marks.get(markName) !== undefined;
};

/**
 * Checks if the current selection in the editor is a node selection of specified types
 * @param editor The Tiptap editor instance
 * @param types An array of node type names to check against
 * @returns boolean indicating if the selected node matches any of the specified types
 */
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
	/**
	 * The protocol scheme to be registered.
	 * @default '''
	 * @example 'ftp'
	 * @example 'git'
	 */
	scheme: string;

	/**
	 * If enabled, it allows optional slashes after the protocol.
	 * @default false
	 * @example true
	 */
	optionalSlashes?: boolean;
};

type ProtocolConfig = Array<ProtocolOptions | string>;

const ATTR_WHITESPACE = /[\u0000-\u0020\u00A0\u1680\u180E\u2000-\u2029\u205F\u3000]/g;

export function isAllowedUri(uri: string | undefined, protocols?: ProtocolConfig) {
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
	} catch {
		// If URL creation fails, it's considered invalid
	}
	return "#";
}
