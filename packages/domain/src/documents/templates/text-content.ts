// Structured content for the text-heavy templates. Layout code reads it; it holds no layout. OPS-79 can export the
// same data to DOCX or feed an editor. `{church_name}` and `{pastor_name}` are the only tokens.
export type Block = { kind: "p"; text: string } | { kind: "list"; items: string[]; ordered?: boolean };
export type TextSection = { heading: string; blocks: Block[] };
export type SignatureSlot = { label: string; name: string; width: number };

export type TextDocumentSpec = {
	id: string;
	title: string;
	subject: string;
	kicker: string;
	/** `document`: numbered sections. `letter`: greeting, body and sign-off from the pastor. */
	style: "document" | "letter";
	intro: string;
	sections: TextSection[];
	closing?: string;
	signatures: SignatureSlot[];
	greeting?: string;
	signOff?: string;
};

const sign = (kind: "member" | "team"): SignatureSlot[] => [
	{ label: kind === "member" ? "Name" : "Name", name: "full_name", width: 190 },
	{ label: "Signature", name: "signature", width: 200 },
	{ label: "Date", name: "signed_date", width: 100 },
];

export const MEMBER_EXPECTATIONS: TextDocumentSpec = {
	id: "member-expectations",
	title: "Expectations of a Core Group Member",
	subject: "What {church_name} asks of each founding core group member",
	kicker: "Core group",
	style: "document",
	intro:
		"Thank you for joining the core group of {church_name}. A new church plant grows from a small team that shows up. This page says what we ask of you, and what you can expect from us.",
	sections: [
		{
			heading: "Be present",
			blocks: [
				{
					kind: "p",
					text: "The core group meets each week. Your presence tells the others that this church plant is worth building.",
				},
				{
					kind: "list",
					items: [
						"Come to the weekly core group meeting.",
						"Arrive on time and stay to the end.",
						"Tell your group leader before you miss a meeting.",
					],
				},
			],
		},
		{
			heading: "GROW",
			blocks: [
				{
					kind: "p",
					text: "We grow together. Join a weekly group, read what we read and ask your questions in the open.",
				},
			],
		},
		{
			heading: "PRAY",
			blocks: [
				{
					kind: "p",
					text: "Pray each week for the neighbors we hope to reach, for the leaders and for Launch Sunday. Pray with the group when we gather.",
				},
			],
		},
		{
			heading: "GIVE",
			blocks: [
				{
					kind: "p",
					text: "Give your time, your gifts and your money toward the launch. Give as you are able. No one is pressed or compared.",
				},
			],
		},
		{
			heading: "Join a team",
			blocks: [
				{
					kind: "p",
					text: "Serve on one launch team before Launch Sunday. Pick the team that fits how God made you. Your group leader will help you choose.",
				},
			],
		},
		{
			heading: "Protect the unity",
			blocks: [
				{
					kind: "p",
					text: "Speak well of the church plant and of its people. Take a concern to the leaders first, and do it in person.",
				},
			],
		},
	],
	closing: "By signing, I say that I have read these expectations and that I will do my best to keep them.",
	signatures: sign("member"),
};

export const LAUNCH_TEAM_COMMITMENT: TextDocumentSpec = {
	id: "launch-team-commitment",
	title: "Launch Team Commitment",
	subject: "The commitment of a launch team member of {church_name}",
	kicker: "Launch team",
	style: "document",
	intro:
		"The launch team carries {church_name} from the first gathering to Launch Sunday and beyond. This letter names what each member commits to. Read it, pray over it and sign it when you are ready.",
	sections: [
		{
			heading: "My role",
			blocks: [
				{
					kind: "p",
					text: "I will serve on one launch team through Launch Sunday and for at least the first three months after it. I will keep the team lead informed of my plans and my limits.",
				},
			],
		},
		{
			heading: "My time",
			blocks: [
				{
					kind: "list",
					items: [
						"I will come to the launch team meetings.",
						"I will come to the training for my team.",
						"I will arrive early on Launch Sunday and stay to help close.",
					],
				},
			],
		},
		{
			heading: "My prayer",
			blocks: [
				{
					kind: "p",
					text: "I will pray each week for the church plant, its leaders, the team and the people we hope to welcome.",
				},
			],
		},
		{
			heading: "My giving",
			blocks: [
				{
					kind: "p",
					text: "I will give regularly and with joy toward the work of this church plant, as God leads me.",
				},
			],
		},
		{
			heading: "My conduct",
			blocks: [
				{
					kind: "p",
					text: "I will treat every guest and every teammate with respect. I will follow the safety rules for children and the guidance of the team lead. I will speak well of the church plant and of its leaders.",
				},
			],
		},
	],
	closing:
		"I make this commitment freely. I understand that I may talk with the pastor at any time if my situation changes.",
	signatures: sign("team"),
};

export const FOLLOW_UP_LETTER: TextDocumentSpec = {
	id: "follow-up-letter",
	title: "Thank You for Coming",
	subject: "A follow-up letter from {church_name} to a vision meeting guest",
	kicker: "Letter",
	style: "letter",
	greeting: "Dear friend,",
	intro: "",
	sections: [
		{
			heading: "",
			blocks: [
				{
					kind: "p",
					text: "Thank you for coming to our vision meeting. It meant a great deal to us that you gave an evening to hear about {church_name}, a new church plant.",
				},
				{
					kind: "p",
					text: "We shared why we believe this church is needed, who we hope to reach and what a Sunday could look like. We would love to hear what you thought. Your questions and your ideas help us build something that serves our neighbors well.",
				},
				{ kind: "p", text: "Here are three ways to take the next step:" },
				{
					kind: "list",
					ordered: true,
					items: [
						"Come to the next vision meeting and bring a friend.",
						"Join a weekly group and meet the core group.",
						"Tell us how you would like to help. Reply to this letter or speak with one of us in person.",
					],
				},
				{
					kind: "p",
					text: "There is no pressure and no obligation. We simply want you to know that you are welcome, and that we are praying for you.",
				},
			],
		},
	],
	signOff: "With gratitude,",
	signatures: [],
};
