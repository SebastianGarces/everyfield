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

export const COMMITMENT_CARD: CardSpec = {
	title: "Core Group Commitment Card",
	subject: "Commitment card: GROW, PRAY, GIVE",
	heading: "My commitment",
	kicker: "Core group",
	neutralTagline: WELCOME,
	leadIn: "Through Launch Sunday, I will:",
	rows: [
		{ name: "commit_grow", tile: "GROW", text: "Join a weekly group and keep learning with the church plant family." },
		{ name: "commit_pray", tile: "PRAY", text: "Pray each week for our neighbors and for Launch Sunday." },
		{ name: "commit_give", tile: "GIVE", text: "Give my time, my gifts and my money toward the launch." },
	],
	fields: [
		{ name: "full_name", label: "Name" },
		{ name: "contact", label: "Email or phone" },
		{ name: "signature", label: "Signature" },
		{ name: "signed_date", label: "Date" },
	],
};

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
