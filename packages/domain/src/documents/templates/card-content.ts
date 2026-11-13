export type CardRow = { name: string; tile?: string; text: string };
type CardField = { name: string; label: string };
export type CardSpec = {
	title: string;
	subject: string;
	heading: string;
	kicker: string;
	neutralTagline: string;
	leadIn: string;
	rows: CardRow[];
	fields: CardField[];
};

const WELCOME = "A new church plant. You are welcome here.";

export const RESPONSE_CARD: CardSpec = {
	title: "Response Card",
	subject: "Response card: how I would like to be involved",
	heading: "Stay in touch",
	kicker: "Vision meeting",
	neutralTagline: WELCOME,
	leadIn: "Thank you for coming. Check each way you would like to be involved:",
	rows: [
		{ name: "involve_updates", text: "Send me news about the church plant." },
		{ name: "involve_group", text: "Invite me to a weekly group." },
		{ name: "involve_serve", text: "I would like to serve on a launch team." },
		{ name: "involve_pray", text: "Add me to the prayer list." },
	],
	fields: [
		{ name: "full_name", label: "Name" },
		{ name: "email", label: "Email" },
		{ name: "phone", label: "Phone" },
	],
};
