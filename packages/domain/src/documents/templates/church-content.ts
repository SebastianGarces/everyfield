// Authored copy of the two new Church Document templates (WP-037). Everyfield ships no doctrinal text: the
// statement-of-faith slot starts empty, and no other block states a belief. `{church_name}` and `{pastor_name}` are the
// merge tokens. A text in square brackets is a prompt the church replaces before it sends the document.
import type { ChurchBlock } from "@everyfield/contracts/documents";

export const BYLAWS_BODY: ChurchBlock[] = [
	{
		kind: "paragraph",
		text: "These bylaws say how {church_name}, a church plant, is governed. Read each article with your board and a lawyer in your state. Then change the words to fit your church plant.",
	},
	{ kind: "heading", text: "Name and purpose" },
	{
		kind: "paragraph",
		text: "The name of this church is {church_name}. It exists to gather people for worship, to help them grow together and to serve its neighbors.",
	},
	{ kind: "heading", text: "Statement of faith" },
	{ kind: "slot", slotId: "statement-of-faith", text: "" },
	{ kind: "heading", text: "Members" },
	{
		kind: "paragraph",
		text: "A person becomes a member when the board accepts the person's written commitment to the church plant. The board keeps the list of members.",
	},
	{
		kind: "paragraph",
		text: "A member who wishes to leave tells the board in writing. The board removes the name from the list.",
	},
	{ kind: "heading", text: "Board" },
	{
		kind: "paragraph",
		text: "A board leads {church_name}. It has no fewer than three members. Change this number if your state sets a different minimum.",
	},
	{ kind: "subheading", text: "What the board does" },
	{
		kind: "bulleted_list",
		items: [
			"It sets the direction of the church plant.",
			"It hires and reviews the pastor.",
			"It approves the budget and watches the finances.",
			"It keeps the records of the church plant.",
		],
	},
	{ kind: "subheading", text: "How a board member serves" },
	{
		kind: "paragraph",
		text: "A board member serves a term of [number] years. A member may serve [number] terms in a row. The board fills an empty seat until the next election.",
	},
	{ kind: "heading", text: "Meetings" },
	{
		kind: "paragraph",
		text: "The board meets at least [number] times each year. The chair gives each member notice of a meeting at least [number] days before it. A majority of the board is a quorum.",
	},
	{
		kind: "paragraph",
		text: "The members of {church_name} meet once each year. The board may call a special meeting when it needs one.",
	},
	{ kind: "heading", text: "Money and accountability" },
	{
		kind: "numbered_list",
		items: [
			"The board approves a budget each year.",
			"Two people count and record every offering.",
			"The board reviews the finances at every meeting.",
			"A person who has no stake in the result reviews the books once each year.",
		],
	},
	{
		kind: "paragraph",
		text: "A board member who has a personal interest in a decision tells the board and does not vote on it.",
	},
	{ kind: "heading", text: "Changes to these bylaws" },
	{
		kind: "paragraph",
		text: "The board may change these bylaws. A change needs the votes of [number] board members and a written notice to the members at least [number] days before the vote.",
	},
	{ kind: "heading", text: "If the church closes" },
	{
		kind: "paragraph",
		text: "If {church_name} closes, the board pays its debts. It gives what remains to a tax-exempt organization that shares its purpose. No board member or member receives any of it.",
	},
];

export const PRAYER_LETTER_BODY: ChurchBlock[] = [
	{ kind: "paragraph", text: "Dear friends," },
	{
		kind: "paragraph",
		text: "Thank you for praying for {church_name}, a new church plant. Your prayers carry us. We want you to know how things stand.",
	},
	{ kind: "subheading", text: "What we are thankful for" },
	{
		kind: "bulleted_list",
		items: ["[Name one thing that went well this month.]", "[Name one person or family you are glad to have met.]"],
	},
	{ kind: "subheading", text: "How to pray this month" },
	{
		kind: "numbered_list",
		items: [
			"[Name a request for our neighbors.]",
			"[Name a request for our team.]",
			"[Name a request for the next step toward Launch Sunday.]",
		],
	},
	{
		kind: "paragraph",
		text: "Thank you for standing with us. If you would like to hear more, reply to this letter or call me any time.",
	},
];
