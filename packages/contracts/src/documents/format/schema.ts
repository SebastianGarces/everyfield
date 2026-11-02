// The everyfield.doc/1 schema: a port of design/doc-format/approach-a/schema.json. Each node lists its group, its
// attributes and the nodes it may hold. Units are points (72 per inch). Colors are theme tokens, never hex values.
// A test keeps this object equal to the design file.
import type { FormatSchema } from "./types.ts";

export const FORMAT_SCHEMA: FormatSchema = {
	format: "everyfield.doc/1",
	limits: {
		nodes: 5000,
		textLength: 20000,
		jsonBytes: 2000000,
	},
	tokens: {
		color: ["none", "ink", "muted-text", "primary", "accent", "muted", "border"],
	},
	pageSizes: {
		letter: {
			width: 612,
			height: 792,
		},
		legal: {
			width: 612,
			height: 1008,
		},
		a4: {
			width: 595,
			height: 842,
		},
		"half-letter": {
			width: 396,
			height: 612,
		},
		"card-4x6": {
			width: 288,
			height: 432,
		},
	},
	envelope: {
		format: {
			type: "const",
			value: "everyfield.doc/1",
		},
		kind: {
			type: "enum",
			values: ["template", "document"],
		},
		id: {
			type: "slug",
		},
		version: {
			type: "int",
			min: 1,
			max: 100000,
		},
		title: {
			type: "string",
			min: 1,
			max: 200,
		},
		description: {
			type: "string",
			max: 500,
			optional: true,
		},
		class: {
			type: "enum",
			values: ["formal/legal", "outward-facing", "operational"],
		},
		exports: {
			type: "list",
			min: 1,
			max: 3,
			of: {
				type: "enum",
				values: ["pdf", "docx", "xlsx"],
			},
		},
		origin: {
			type: "object",
			nullable: true,
			optional: true,
			props: {
				template: {
					type: "slug",
				},
				version: {
					type: "int",
					min: 1,
					max: 100000,
				},
				hash: {
					type: "string",
					pattern: "^sha256:[0-9a-f]{64}$",
				},
			},
		},
		fields: {
			type: "list",
			max: 100,
			of: {
				type: "object",
				props: {
					key: {
						type: "key",
					},
					label: {
						type: "string",
						min: 1,
						max: 80,
					},
					type: {
						type: "enum",
						values: ["text", "date", "number", "list"],
					},
					source: {
						type: "string",
						max: 80,
						nullable: true,
						optional: true,
					},
					required: {
						type: "bool",
						optional: true,
					},
					sample: {
						type: "any",
						optional: true,
					},
					fallback: {
						type: "string",
						max: 500,
						optional: true,
					},
				},
			},
		},
		data: {
			type: "map",
			optional: true,
		},
		page: {
			type: "page",
		},
		body: {
			type: "node",
			node: "doc",
		},
	},
	page: {
		size: {
			type: "enum",
			values: ["letter", "legal", "a4", "half-letter", "card-4x6", "custom"],
		},
		width: {
			type: "number",
			min: 144,
			max: 1728,
			optional: true,
		},
		height: {
			type: "number",
			min: 144,
			max: 1728,
			optional: true,
		},
		orientation: {
			type: "enum",
			values: ["portrait", "landscape"],
		},
		margin: {
			type: "object",
			props: {
				top: {
					type: "number",
					min: 0,
					max: 144,
				},
				right: {
					type: "number",
					min: 0,
					max: 144,
				},
				bottom: {
					type: "number",
					min: 0,
					max: 144,
				},
				left: {
					type: "number",
					min: 0,
					max: 144,
				},
			},
		},
		tile: {
			type: "object",
			nullable: true,
			optional: true,
			props: {
				across: {
					type: "int",
					min: 1,
					max: 4,
				},
				down: {
					type: "int",
					min: 1,
					max: 6,
				},
				padding: {
					type: "number",
					min: 0,
					max: 72,
				},
				cutMarks: {
					type: "bool",
				},
			},
		},
		header: {
			type: "region",
			optional: true,
			nullable: true,
		},
		footer: {
			type: "region",
			optional: true,
			nullable: true,
		},
	},
	region: {
		pages: {
			type: "enum",
			values: ["all", "first", "rest"],
		},
		content: {
			type: "blocks",
		},
	},
	nodes: {
		doc: {
			group: "root",
			attrs: {},
			content: {
				allow: ["block"],
				min: 0,
			},
		},
		paragraph: {
			group: "block",
			attrs: {
				align: {
					type: "enum",
					values: ["left", "center", "right"],
					default: "left",
				},
				style: {
					type: "enum",
					values: ["body", "lead", "small", "kicker"],
					default: "body",
				},
			},
			content: {
				allow: ["inline"],
				min: 0,
			},
		},
		heading: {
			group: "block",
			attrs: {
				level: {
					type: "int",
					min: 1,
					max: 3,
					default: 2,
				},
				numbered: {
					type: "bool",
					default: false,
				},
				align: {
					type: "enum",
					values: ["left", "center", "right"],
					default: "left",
				},
			},
			content: {
				allow: ["inline"],
				min: 0,
			},
		},
		bulletList: {
			group: "block",
			attrs: {},
			content: {
				allow: ["listItem"],
				min: 1,
				max: 200,
			},
		},
		orderedList: {
			group: "block",
			attrs: {},
			content: {
				allow: ["listItem"],
				min: 1,
				max: 200,
			},
		},
		listItem: {
			group: "listItem",
			attrs: {},
			content: {
				allow: ["paragraph"],
				min: 1,
				max: 20,
			},
		},
		quote: {
			group: "block",
			attrs: {},
			content: {
				allow: ["paragraph"],
				min: 1,
				max: 50,
			},
		},
		divider: {
			group: "block",
			attrs: {
				weight: {
					type: "enum",
					values: ["hairline", "rule", "bar"],
					default: "rule",
				},
				color: {
					type: "token",
					default: "ink",
				},
			},
			content: null,
		},
		spacer: {
			group: "block",
			attrs: {
				size: {
					type: "number",
					min: 2,
					max: 288,
					default: 12,
				},
			},
			content: null,
		},
		pageBreak: {
			group: "block",
			attrs: {},
			content: null,
		},
		columns: {
			group: "block",
			attrs: {
				gap: {
					type: "number",
					min: 0,
					max: 72,
					default: 12,
				},
				valign: {
					type: "enum",
					values: ["top", "center", "bottom"],
					default: "top",
				},
			},
			content: {
				allow: ["column"],
				min: 2,
				max: 4,
			},
		},
		column: {
			group: "column",
			attrs: {
				width: {
					type: "number",
					min: 1,
					max: 12,
					default: 1,
				},
				align: {
					type: "enum",
					values: ["left", "center", "right"],
					default: "left",
				},
			},
			content: {
				allow: ["block"],
				min: 0,
				deny: ["pageBreak", "columns"],
			},
		},
		box: {
			group: "block",
			attrs: {
				fill: {
					type: "token",
					default: "none",
				},
				border: {
					type: "token",
					default: "border",
				},
				padding: {
					type: "number",
					min: 0,
					max: 72,
					default: 12,
				},
				keepTogether: {
					type: "bool",
					default: true,
				},
			},
			content: {
				allow: ["block"],
				min: 0,
				deny: ["pageBreak", "box"],
			},
		},
		image: {
			group: "block",
			attrs: {
				source: {
					type: "enum",
					values: ["logo", "mark", "photo"],
					default: "logo",
				},
				width: {
					type: "number",
					min: 8,
					max: 1440,
					default: 150,
				},
				height: {
					type: "number",
					min: 8,
					max: 1440,
					default: 34,
				},
				align: {
					type: "enum",
					values: ["left", "center", "right"],
					default: "left",
				},
				alt: {
					type: "string",
					max: 200,
					default: "",
				},
			},
			content: null,
		},
		writeIn: {
			group: "block",
			attrs: {
				label: {
					type: "string",
					min: 1,
					max: 80,
					default: "Name",
				},
				key: {
					type: "key",
					default: "name",
				},
				kind: {
					type: "enum",
					values: ["text", "signature", "date"],
					default: "text",
				},
				width: {
					type: "number",
					min: 0,
					max: 1440,
					default: 0,
				},
			},
			content: null,
		},
		slot: {
			group: "block",
			attrs: {
				label: {
					type: "string",
					min: 1,
					max: 80,
					default: "Statement of faith",
				},
			},
			content: {
				allow: ["paragraph", "bulletList", "orderedList"],
				min: 0,
			},
		},
		table: {
			group: "block",
			attrs: {
				style: {
					type: "enum",
					values: ["grid", "rows", "ledger"],
					default: "grid",
				},
				header: {
					type: "bool",
					default: true,
				},
				headerFill: {
					type: "token",
					default: "muted",
				},
				zebra: {
					type: "bool",
					default: false,
				},
				writeInRows: {
					type: "int",
					min: 0,
					max: 200,
					default: 0,
				},
				rowHeight: {
					type: "number",
					min: 0,
					max: 144,
					default: 0,
				},
				source: {
					type: "key",
					nullable: true,
					default: null,
				},
				sheet: {
					type: "string",
					max: 31,
					nullable: true,
					default: null,
				},
				columns: {
					type: "list",
					min: 1,
					max: 16,
					of: {
						type: "object",
						props: {
							id: {
								type: "key",
							},
							label: {
								type: "string",
								max: 80,
							},
							type: {
								type: "enum",
								values: ["text", "number", "money", "check", "index", "formula"],
							},
							width: {
								type: "number",
								min: 0,
								max: 1440,
							},
							align: {
								type: "enum",
								values: ["left", "center", "right"],
								optional: true,
							},
							formula: {
								type: "string",
								max: 200,
								optional: true,
							},
							format: {
								type: "enum",
								values: ["number", "money"],
								optional: true,
							},
						},
					},
				},
			},
			content: {
				allow: ["row"],
				min: 0,
				max: 1000,
			},
		},
		row: {
			group: "row",
			attrs: {
				role: {
					type: "enum",
					values: ["item", "group", "subtotal", "total"],
					default: "item",
				},
				sign: {
					type: "enum",
					values: ["add", "subtract"],
					default: "add",
				},
			},
			content: {
				allow: ["cell"],
				min: 1,
				max: 16,
			},
		},
		cell: {
			group: "cell",
			attrs: {
				value: {
					type: "number",
					nullable: true,
					default: null,
				},
				checked: {
					type: "bool",
					default: false,
				},
			},
			content: {
				allow: ["inline"],
				min: 0,
			},
		},
		text: {
			group: "inline",
			attrs: {},
			content: null,
			text: true,
		},
		field: {
			group: "inline",
			attrs: {
				key: {
					type: "key",
				},
			},
			content: null,
		},
		hardBreak: {
			group: "inline",
			attrs: {},
			content: null,
		},
		pageNumber: {
			group: "inline",
			attrs: {
				format: {
					type: "enum",
					values: ["page", "page-of-total"],
					default: "page-of-total",
				},
			},
			content: null,
		},
	},
	marks: {
		bold: {
			attrs: {},
		},
		italic: {
			attrs: {},
		},
		underline: {
			attrs: {},
		},
		link: {
			attrs: {
				href: {
					type: "string",
					min: 1,
					max: 2000,
					pattern: "^(https?://|mailto:)",
				},
			},
		},
		tag: {
			attrs: {},
		},
	},
};
