// Authored copy of the four priority-1 policy templates (WP-037, from OPS-88). Everyfield ships no doctrinal text and no
// invented name, figure or decision. `{church_name}` is the merge token. A text in square brackets is a prompt the
// church replaces before it signs the document.
import type { ChurchBlock } from "@everyfield/contracts/documents";

export const BOARD_MINUTES_BODY: ChurchBlock[] = [
	{
		kind: "paragraph",
		text: "These are the minutes of a board meeting of {church_name}, a church plant. The secretary fills in each bracketed prompt during or just after the meeting. Delete any section that did not happen, and add what the board did that this form does not cover.",
	},
	{ kind: "heading", text: "The meeting" },
	{
		kind: "bulleted_list",
		items: [
			"Date: [date]",
			"Time the meeting began: [time]",
			"Place: [place]",
			"Called to order by: [name]",
			"Minutes taken by: [name]",
		],
	},
	{ kind: "heading", text: "Board members present and absent" },
	{
		kind: "bulleted_list",
		items: [
			"Present: [names of the board members who came]",
			"Absent: [names of the board members who did not come]",
			"Others who came: [names and roles, or write none]",
		],
	},
	{ kind: "heading", text: "Quorum" },
	{
		kind: "paragraph",
		text: "The bylaws set the quorum. Count the board members present, and write what you find. Quorum was [met or not met] with [number] of [number] board members present.",
	},
	{ kind: "heading", text: "Approval of the last minutes" },
	{
		kind: "paragraph",
		text: "The board read the minutes of the meeting held on [date of the last meeting]. The board [approved them as written, approved them with changes, or did not approve them].",
	},
	{ kind: "heading", text: "Financial report" },
	{
		kind: "paragraph",
		text: "[Name of the person who reported] gave the financial report for [period]. The board [accepted the report or asked for changes]. Attach the report to these minutes.",
	},
	{ kind: "heading", text: "Conflicts of interest disclosed" },
	{
		kind: "paragraph",
		text: "A board member who has a personal interest in a decision tells the board and does not vote on it. Write each disclosure here. If no one disclosed an interest, write none.",
	},
	{
		kind: "bulleted_list",
		items: [
			"Board member: [name]",
			"Interest: [what the interest is]",
			"Decision it touches: [the decision]",
			"How the board dealt with it: [for example, the member left the room and did not vote]",
		],
	},
	{ kind: "heading", text: "Decisions" },
	{
		kind: "paragraph",
		text: "Write each motion in its own entry. Copy the entry for each additional motion.",
	},
	{
		kind: "bulleted_list",
		items: [
			"Motion: [what the board decided to do]",
			"Moved by: [name]",
			"Seconded by: [name]",
			"Vote: [number] for, [number] against, [number] not voting",
			"Result: [passed or failed]",
		],
	},
	{ kind: "heading", text: "Action items" },
	{
		kind: "paragraph",
		text: "Write each task the board gave to a person. Copy the entry for each additional task.",
	},
	{
		kind: "bulleted_list",
		items: ["Task: [what the person will do]", "Owner: [name]", "Due: [date]"],
	},
	{ kind: "heading", text: "Adjournment" },
	{
		kind: "paragraph",
		text: "The chair ended the meeting at [time]. The next meeting is on [date] at [place].",
	},
];

export const CONFLICT_OF_INTEREST_BODY: ChurchBlock[] = [
	{
		kind: "paragraph",
		text: "This policy says how the board of {church_name}, a church plant, deals with a personal interest in a decision. Read it with your board and a lawyer in your state. Then change the words to fit your church plant.",
	},
	{ kind: "heading", text: "Purpose" },
	{
		kind: "paragraph",
		text: "The board makes decisions for the whole church plant. This policy keeps those decisions free of private gain. It also protects each board member from the doubt that an undisclosed interest can cause.",
	},
	{ kind: "heading", text: "Who this policy covers" },
	{
		kind: "paragraph",
		text: "This policy covers each board member of {church_name}. The board may also apply it to the pastor, to staff and to any person who can spend the money of the church plant.",
	},
	{ kind: "heading", text: "What counts as an interest" },
	{
		kind: "paragraph",
		text: "A board member has an interest when a decision could help the member, the member's family or a business that the member owns or leads. The help may be money or it may be something else.",
	},
	{
		kind: "bulleted_list",
		items: [
			"A financial interest. Examples: a contract, a sale, a rental, a salary or a gift.",
			"A personal interest. Examples: a job for a relative, a friendship that could sway the vote or a duty to another organization.",
		],
	},
	{ kind: "heading", text: "The duty to disclose" },
	{
		kind: "paragraph",
		text: "A board member who has a personal interest in a decision tells the board and does not vote on it. The member tells the board as soon as the member knows of the interest. The member tells the chair or the secretary in writing, or says it at the meeting.",
	},
	{ kind: "heading", text: "How the board decides" },
	{
		kind: "paragraph",
		text: "The member explains the interest and answers questions. Then the member leaves the room. The other board members decide by a majority vote whether a conflict exists. If they are not sure, they treat the interest as a conflict.",
	},
	{ kind: "heading", text: "When a conflict exists" },
	{
		kind: "numbered_list",
		items: [
			"The conflicted member stays out of the discussion and does not vote.",
			"The conflicted member does not try to sway the other members.",
			"The other board members compare the choice with at least one other choice, when they can.",
			"The board approves the choice only if it is fair to {church_name}. At least [number] disinterested board members must vote for it.",
		],
	},
	{ kind: "heading", text: "Record in the minutes" },
	{
		kind: "paragraph",
		text: "The secretary writes each disclosure and each decision in the minutes of the meeting. The minutes name the member, state the interest and say who voted. They also say that the member left the room.",
	},
	{ kind: "heading", text: "Yearly statement" },
	{
		kind: "paragraph",
		text: "Each board member signs a written statement once each year, by [date]. The statement says that the member has read this policy and lists every interest that the policy covers. A new board member signs one before the first vote. The secretary keeps the statements with the records of the church plant.",
	},
	{ kind: "heading", text: "If a member breaks this policy" },
	{
		kind: "paragraph",
		text: "The board hears the facts and listens to the member. If the board finds that the member broke this policy, it decides what to do. It may reverse the decision, ask the member to step down or remove the member as the bylaws allow.",
	},
];

export const FINANCIAL_CONTROLS_BODY: ChurchBlock[] = [
	{
		kind: "paragraph",
		text: "This policy says how {church_name}, a church plant, handles its money. It keeps the money safe and it protects the people who handle it. Read it with your board and a lawyer in your state. Then change the words to fit your church plant.",
	},
	{ kind: "heading", text: "The budget" },
	{
		kind: "paragraph",
		text: "The board approves a budget each year, before the year starts. The board approves each change to the budget. Spending outside the budget needs the approval of the board first.",
	},
	{ kind: "heading", text: "Counting and recording offerings" },
	{
		kind: "numbered_list",
		items: [
			"Two people who are not related count each offering. They do not live in the same home.",
			"The two people count together, and both sign the counting sheet.",
			"They record each gift and the total on the counting sheet before they leave the room.",
			"They keep the money in sight until they have sealed it.",
		],
	},
	{ kind: "heading", text: "Deposits" },
	{
		kind: "paragraph",
		text: "The counters deposit the offering at the bank as soon as they can. The deposit is made no later than [number] business days after the offering. Until then, the money stays in a locked place.",
	},
	{ kind: "heading", text: "Designated gifts" },
	{
		kind: "paragraph",
		text: "When a giver names a purpose for a gift, the church plant uses the gift for that purpose. The counters record the purpose with the gift. The treasurer tracks each designated fund apart from the general fund.",
	},
	{ kind: "heading", text: "Spending limits" },
	{
		kind: "paragraph",
		text: "The board sets two limits. A person who spends church plant money follows the limit that fits the amount.",
	},
	{
		kind: "bulleted_list",
		items: [
			"Below [low amount]: one authorized signer may approve the payment.",
			"From [low amount] up to [high amount]: two authorized signers approve the payment. They are not related.",
			"Above [high amount]: the board approves the payment before anyone makes it.",
		],
	},
	{
		kind: "paragraph",
		text: "The same rule holds for checks, online payments and card purchases. For an online payment or a card purchase, the signers sign a request form or an approved invoice.",
	},
	{ kind: "heading", text: "Blank checks and forms" },
	{
		kind: "paragraph",
		text: "No one signs a blank check or a blank request form in advance. A signer signs only after the amount, the payee and the purpose are written down.",
	},
	{ kind: "heading", text: "Bank reconciliation" },
	{
		kind: "paragraph",
		text: "Each month, a person who does not sign checks compares the bank statement with the records of the church plant. That person looks into each difference, writes down what was found and reports it to the board.",
	},
	{ kind: "heading", text: "Reports to the board" },
	{
		kind: "paragraph",
		text: "The treasurer gives the board a financial report at each board meeting. The report shows what came in, what went out and what remains. The report compares these figures with the budget.",
	},
	{ kind: "heading", text: "Yearly review of the books" },
	{
		kind: "paragraph",
		text: "Once each year, a person who has no stake in the result reviews the books. The reviewer does not sign checks, does not count offerings and is not related to a person who does. The reviewer reports in writing to the board.",
	},
	{ kind: "heading", text: "Records" },
	{
		kind: "paragraph",
		text: "The church plant keeps its counting sheets, bank statements, receipts, request forms, reports and minutes for [number] years. It keeps its governing documents for as long as it exists. Ask a lawyer in your state or an accountant how long the law requires you to keep each kind of record.",
	},
];

export const ACCOUNTABLE_PLAN_BODY: ChurchBlock[] = [
	{
		kind: "paragraph",
		text: "This plan says how {church_name}, a church plant, repays the expenses that a person pays for it. When a church plant follows these rules, the repayment is not taxable pay for the person. Read this plan with an accountant or a lawyer in your state before you adopt it.",
	},
	{ kind: "heading", text: "Purpose" },
	{
		kind: "paragraph",
		text: "This plan is an accountable plan under the rules of the Internal Revenue Service (IRS). It repays real business expenses of the church plant. It does not pay a person extra money.",
	},
	{ kind: "heading", text: "Who the plan covers" },
	{
		kind: "paragraph",
		text: "This plan covers [the pastor, staff members and volunteers whom the board names]. The board may add a person or take one away by a vote that it records in the minutes.",
	},
	{ kind: "heading", text: "Which expenses qualify" },
	{
		kind: "paragraph",
		text: "An expense qualifies when it has a business connection. This means the person paid it while doing work for {church_name}. The church plant repays the expense only if the person has not been repaid by anyone else.",
	},
	{
		kind: "bulleted_list",
		items: [
			"Travel for church plant work, such as a trip to a meeting or a training.",
			"Supplies and materials that the church plant needs.",
			"Meals and lodging while the person is away on church plant work.",
			"Other costs the board has approved in advance.",
		],
	},
	{ kind: "heading", text: "What a request must include" },
	{
		kind: "paragraph",
		text: "A person asks for repayment in writing. The request gives each of these items.",
	},
	{
		kind: "numbered_list",
		items: [
			"The amount of the expense.",
			"The date of the expense.",
			"The place of the expense.",
			"The business purpose of the expense.",
			"A receipt for each expense of [receipt amount] or more.",
		],
	},
	{ kind: "heading", text: "Time to submit a request" },
	{
		kind: "paragraph",
		text: "The person gives the request and the receipts to [the treasurer] within 60 days after the person paid or incurred the expense. The church plant does not repay a request that comes later than that.",
	},
	{ kind: "heading", text: "Advances" },
	{
		kind: "paragraph",
		text: "The church plant may pay an advance. The advance covers an expense that the person expects to pay within 30 days. The advance may not be more than the person expects to spend. The person returns any amount the person did not spend within 120 days after the person paid or incurred the expense.",
	},
	{ kind: "heading", text: "Mileage" },
	{
		kind: "paragraph",
		text: "The church plant repays mileage for church plant work at [rate] per mile. The board sets this rate. The person keeps a log that gives the date, the places, the miles and the purpose of each trip. The IRS publishes a standard rate each year, and the board may use it.",
	},
	{ kind: "heading", text: "What the church plant does not repay" },
	{
		kind: "bulleted_list",
		items: [
			"An expense that is personal, such as a commute between home and the usual place of work.",
			"An expense without a receipt or a log, when this plan asks for one.",
			"An expense that another person or group has already repaid.",
			"A fine, a penalty or a late fee that the person caused.",
		],
	},
	{ kind: "heading", text: "An expense outside the plan" },
	{
		kind: "paragraph",
		text: "Money that the church plant pays for an expense outside this plan is taxable pay. This includes an advance that the person does not return in time and a request that comes too late. The treasurer adds the amount to the person's pay and reports it as the tax rules require.",
	},
	{ kind: "heading", text: "Changes to this plan" },
	{
		kind: "paragraph",
		text: "The board may change a limit in this plan by a vote that it records in the minutes. Check with an accountant before you pick a limit longer than the IRS safe-harbor limits of 60 days and 120 days.",
	},
];
