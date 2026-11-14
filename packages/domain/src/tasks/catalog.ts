import type * as c from "@everyfield/contracts/tasks";
import type { z } from "zod";

// The Everyfield phase checklists (REQ-TSK-009): the 20 checklists of docs/reference/task-templates.ts, Phases 0 to 6,
// as fixed data in code with no template tables. Each item's priority is its own or its checklist's default, and its
// offset counts days after the import date or, for a phase offer, the plant-local date of the move. Raise `version`
// whenever any wording, offset or key changes: an import or offer answer that names an older version is refused, and
// tasks already created keep their own copy. tests/integration/tasks/templates.test.mts compares this file with the
// reference item by item. Two titles spell the brand "Everyfield" where the frozen reference keeps its legacy
// spelling (decisions.md, 2026-10-23 brand spelling). Every item carries a description: the reference has one on
// only 4 items, which are kept verbatim, and the rest are written here (decisions.md D87). Version 3 drops the three
// items the Launch plan's readiness tasks own once a launch date is set: the invite drop and the press release of
// Promotion Campaign and the venue booking of Pre-Launch Services (Sebastian, Nov 6, 2026; WP-045). Tasks already
// created from them stay as they are.

type Key = z.infer<typeof c.templateKey>;
type ChecklistItem = {
	key: Key;
	title: string;
	description: string;
	priority: z.infer<typeof c.priority>;
	offsetDays: number;
};
export type Checklist = {
	key: Key;
	name: string;
	description: string;
	phase: z.infer<typeof c.checklistSummary>["phase"];
	category: z.infer<typeof c.category>;
	items: readonly ChecklistItem[];
};
export type Catalog = { version: number; checklists: readonly Checklist[] };

export const CATALOG: Catalog = {
	version: 3,
	checklists: [
		{
			key: "discernment-and-preparation",
			name: "Discernment & Preparation",
			description:
				"The work that happens before anyone is gathered — prayer, ground work and the commitments this plant will ask for.",
			phase: 0,
			category: "administrative",
			items: [
				{
					key: "vision-summary",
					title: "Write a one-page vision summary",
					description:
						"Who this church is for, what it will be like, and why here. One page — it has to survive being read aloud.",
					priority: "high",
					offsetDays: 3,
				},
				{
					key: "intercessors",
					title: "List the people already praying for this plant",
					description:
						"Names, not a vague sense of support. Ask each one if they will pray weekly and hear a short update.",
					priority: "medium",
					offsetDays: 5,
				},
				{
					key: "meet-a-coach",
					title: "Meet a potential coach",
					description:
						"Someone who has planted before and will tell you the truth. Meet before you need them, not after.",
					priority: "high",
					offsetDays: 10,
				},
				{
					key: "walk-the-ground",
					title: "Walk the neighbourhood and write down what you see",
					description:
						"Walk it at different times of day. Note the schools, the shops, the empty buildings and who is out on the street.",
					priority: "medium",
					offsetDays: 7,
				},
				{
					key: "family-commitments",
					title: "Agree the commitments this plant will ask of your family",
					description:
						"Time, money, Sundays and the home. Agree them out loud now so nobody discovers them in month six.",
					priority: "medium",
					offsetDays: 14,
				},
				{
					key: "first-year-budget",
					title: "Draft a budget for the first year",
					description:
						"Income you can count on, costs you cannot avoid, and the gap between them. A rough number now beats a perfect one later.",
					priority: "medium",
					offsetDays: 21,
				},
			],
		},
		{
			key: "vision-meeting-preparation",
			name: "Vision Meeting Preparation",
			description: "Everything between setting a vision meeting date and standing up to give the talk.",
			phase: 1,
			category: "vision_meeting",
			items: [
				{
					key: "set-date",
					title: "Set the vision meeting date and time",
					description:
						"Every invitation, booking and reminder counts from this. Pick an evening people can actually come.",
					priority: "high",
					offsetDays: 0,
				},
				{
					key: "invite-list",
					title: "Write the invitation list",
					description:
						"Everyone who might say yes, and who will invite them. Personal invitations fill the room; posters do not.",
					priority: "high",
					offsetDays: 2,
				},
				{
					key: "confirm-venue",
					title: "Confirm the venue",
					description:
						"Book it in writing, with access times, seating, a screen if you need one and somewhere for the children.",
					priority: "medium",
					offsetDays: 3,
				},
				{
					key: "send-invitations",
					title: "Send the invitations",
					description:
						"Send them personally, with the date, time, place and one line on why it matters. Three weeks out is about right.",
					priority: "high",
					offsetDays: 5,
				},
				{
					key: "arrange-childcare",
					title: "Arrange childcare for the meeting",
					description:
						"Parents stay home when there is nowhere for the children. Book checked volunteers and a separate room.",
					priority: "medium",
					offsetDays: 9,
				},
				{
					key: "prepare-talk",
					title: "Prepare the vision talk",
					description: "Twenty minutes: why this place, why now, and what you are asking people to do next.",
					priority: "medium",
					offsetDays: 10,
				},
				{
					key: "print-materials",
					title: "Print response cards and name tags",
					description:
						"A response card on every seat is how interest gets written down. Name tags help strangers become names.",
					priority: "medium",
					offsetDays: 12,
				},
				{
					key: "refreshments",
					title: "Arrange refreshments",
					description:
						"Something to hold and a reason to stay and talk afterwards. Keep it simple and put someone in charge of it.",
					priority: "low",
					offsetDays: 12,
				},
				{
					key: "confirm-attendance",
					title: "Confirm attendance by phone",
					description: "A text is an invitation; a call is a commitment. Ring everyone who said yes.",
					priority: "high",
					offsetDays: 13,
				},
				{
					key: "set-the-room",
					title: "Set the room up and rehearse the talk",
					description: "Set it the way you want it on the night, then give the talk once out loud in that room.",
					priority: "medium",
					offsetDays: 14,
				},
			],
		},
		{
			key: "post-meeting-follow-up",
			name: "Post-Meeting Follow-Up",
			description: "The week after a vision meeting, where interest either becomes a core group or evaporates.",
			phase: 1,
			category: "follow_up",
			items: [
				{
					key: "record-attendance",
					title: "Record attendance and response cards",
					description: "Enter every name and every response card within a day, while you still remember who said what.",
					priority: "high",
					offsetDays: 0,
				},
				{
					key: "thank-you",
					title: "Send a thank-you message to everyone who came",
					description: "Within two days, short and personal. Thank them for coming and say what happens next.",
					priority: "high",
					offsetDays: 1,
				},
				{
					key: "call-the-yeses",
					title: "Call everyone who said yes",
					description:
						"Within the week, while it is still warm. Thank them, answer questions and tell them the next step.",
					priority: "urgent",
					offsetDays: 3,
				},
				{
					key: "call-the-undecided",
					title: "Call everyone who was undecided",
					description:
						"Ask what would help them decide. Listen more than you pitch, and agree when you will speak again.",
					priority: "high",
					offsetDays: 5,
				},
				{
					key: "note-declines",
					title: "Note why anyone declined",
					description:
						"A no is information. Write down the reason so you can see a pattern and know who to stay friends with.",
					priority: "low",
					offsetDays: 5,
				},
				{
					key: "book-coffees",
					title: "Book one-to-one coffees with the interested",
					description:
						"One to one is where interest becomes commitment. Get a date in the diary before the week is out.",
					priority: "high",
					offsetDays: 7,
				},
				{
					key: "update-pipeline",
					title: "Move everyone to their real status in the pipeline",
					description:
						"Yes, undecided or no, as it really stands after the calls. A tidy pipeline tells you who to call next.",
					priority: "high",
					offsetDays: 7,
				},
			],
		},
		{
			key: "core-group-onboarding",
			name: "Core Group Onboarding",
			description: "Turning a list of interested people into a core group that meets, prays and gives.",
			phase: 1,
			category: "general",
			items: [
				{
					key: "share-vision-doc",
					title: "Share the vision document with the core group",
					description:
						"Everyone should be able to say what this church is for. Send it, then talk it through together.",
					priority: "medium",
					offsetDays: 2,
				},
				{
					key: "weekly-gathering",
					title: "Set the weekly core group gathering",
					description: "Same day, same time, every week. A rhythm is what turns interested people into a group.",
					priority: "high",
					offsetDays: 3,
				},
				{
					key: "covenant",
					title: "Agree the core group covenant",
					description:
						"What members commit to: showing up, praying, giving and serving. Short enough to sign and mean.",
					priority: "medium",
					offsetDays: 10,
				},
				{
					key: "serving-conversation",
					title: "Ask each member where they want to serve",
					description: "Ask one by one, not by sign-up sheet. Note their gifts and what they would rather not do.",
					priority: "medium",
					offsetDays: 14,
				},
				{
					key: "giving-conversation",
					title: "Start the giving conversation with the core group",
					description:
						"Be plain about the budget and what giving makes possible. A group that gives early owns the plant.",
					priority: "medium",
					offsetDays: 21,
				},
				{
					key: "pray-for-launch-team",
					title: "Pray through the launch team names together",
					description: "Name by name, together. It keeps people in view and shows where the gaps are.",
					priority: "low",
					offsetDays: 21,
				},
			],
		},
		{
			key: "ministry-team-setup",
			name: "Ministry Team Setup",
			description: "Deciding which teams launch day needs, and putting a name against each one.",
			phase: 2,
			category: "ministry_team",
			items: [
				{
					key: "name-coordinator",
					title: "Name the launch coordinator",
					description: "One person who holds every team's progress and knows who to ask. Not the planter.",
					priority: "high",
					offsetDays: 2,
				},
				{
					key: "decide-teams",
					title: "Decide which ministry teams launch day needs",
					description:
						"Start from what launch Sunday needs and work back. Fewer, well-staffed teams beat many thin ones.",
					priority: "high",
					offsetDays: 3,
				},
				{
					key: "name-leaders",
					title: "Name a leader for each ministry team",
					description:
						"One name against each team, asked personally, with a clear yes. A team without a leader is a wish.",
					priority: "high",
					offsetDays: 10,
				},
				{
					key: "team-descriptions",
					title: "Write a one-paragraph description for each team",
					description:
						"What the team does, when it serves and what it asks of people. It is the recruiting pitch and the job description.",
					priority: "medium",
					offsetDays: 12,
				},
				{
					key: "core-group-picks",
					title: "Ask core group members to pick a team",
					description: "Give everyone the team descriptions and ask for a first and second choice by a set date.",
					priority: "medium",
					offsetDays: 14,
				},
				{
					key: "first-leaders-meeting",
					title: "Hold the first ministry team leaders meeting",
					description:
						"Share the timeline, the team descriptions and what launch day looks like. Leave with next steps for each team.",
					priority: "medium",
					offsetDays: 17,
				},
				{
					key: "meeting-rhythm",
					title: "Agree how often each team meets",
					description: "Some teams need weekly practice, some a monthly check-in. Agree it now so nobody guesses.",
					priority: "low",
					offsetDays: 17,
				},
				{
					key: "shared-calendar",
					title: "Put every team meeting on the shared calendar",
					description: "One calendar everyone can see stops clashes and missed meetings before they happen.",
					priority: "low",
					offsetDays: 21,
				},
				{
					key: "recruit-for-gaps",
					title: "Review the team gaps and recruit for them",
					description:
						"Count the people each team needs against the names it has. Ask personally to fill the difference.",
					priority: "medium",
					offsetDays: 28,
				},
			],
		},
		{
			key: "launch-date-planning",
			name: "Launch Date Planning",
			description: "Choosing the Sunday everything else counts down to, and telling everyone who needs to know.",
			phase: 2,
			category: "launch_prep",
			items: [
				{
					key: "pick-a-sunday",
					title: "Pick a target launch Sunday",
					description:
						"Allow enough runway for training, previews and promotion. Everything else counts down from this date.",
					priority: "urgent",
					offsetDays: 3,
				},
				{
					key: "check-calendars",
					title: "Check the date against school and local calendars",
					description:
						"Avoid school holidays, bank holidays and big local events. A clash costs you the guests you invited.",
					priority: "high",
					offsetDays: 4,
				},
				{
					key: "venue-free",
					title: "Confirm the venue is free on that date",
					description:
						"Get it in writing, with access times for setup. The best Sunday is no use if the hall is booked.",
					priority: "high",
					offsetDays: 7,
				},
				{
					key: "work-backwards",
					title: "Work backwards and set the preview service dates",
					description:
						"Count back from launch to set each preview service, with time between them to fix what goes wrong.",
					priority: "high",
					offsetDays: 10,
				},
				{
					key: "tell-core-group",
					title: "Tell the core group the launch date",
					description: "Tell them in person before anyone else hears. It is their date as much as yours.",
					priority: "high",
					offsetDays: 12,
				},
				{
					key: "tell-oversight",
					title: "Tell the sending church and network",
					description: "The sending church and network plan their support around it. Tell them early and in writing.",
					priority: "high",
					offsetDays: 12,
				},
				{
					key: "publish-the-date",
					title: "Record the launch date in Everyfield",
					description: "The countdown, the milestones and the oversight announcement all hang off this one date.",
					priority: "high",
					offsetDays: 14,
				},
			],
		},
		{
			key: "project-timeline-creation",
			name: "Project Timeline Creation",
			description: "Milestones, owners and the review rhythm that keeps the plan honest.",
			phase: 2,
			category: "administrative",
			items: [
				{
					key: "list-milestones",
					title: "List every milestone between now and launch",
					description:
						"Teams staffed, classes run, previews held, invites out. Each one dated, from now to launch Sunday.",
					priority: "medium",
					offsetDays: 5,
				},
				{
					key: "milestone-owners",
					title: "Put an owner on each milestone",
					description: "One name per milestone. Shared ownership usually means nobody owns it.",
					priority: "high",
					offsetDays: 8,
				},
				{
					key: "planning-rhythm",
					title: "Agree the weekly planning rhythm",
					description: "A short weekly check of what moved, what is stuck and what is next keeps the plan honest.",
					priority: "medium",
					offsetDays: 8,
				},
				{
					key: "budget-review",
					title: "Set a monthly budget review",
					description: "Once a month, compare spending with the budget, so a surprise is small when you find it.",
					priority: "low",
					offsetDays: 12,
				},
				{
					key: "define-ready",
					title: 'Write down what "ready to launch" means',
					description:
						"Teams staffed, children safe, venue booked, previews done. Write the list you will check yourself against.",
					priority: "high",
					offsetDays: 15,
				},
				{
					key: "review-with-coach",
					title: "Review the timeline with your coach",
					description: "A second pair of eyes finds the gaps you have stopped seeing. Bring the dates and the owners.",
					priority: "medium",
					offsetDays: 20,
				},
			],
		},
		{
			key: "peak-performance-classes",
			name: "Peak Performance Classes",
			description: "Booking, filling and running the Peak Performance class series with the core group.",
			phase: 3,
			category: "training",
			items: [
				{
					key: "book-dates",
					title: "Book the class dates",
					description:
						"Book the whole series at once, so the core group can plan around it and nobody misses a session.",
					priority: "high",
					offsetDays: 3,
				},
				{
					key: "invite-core-group",
					title: "Invite the core group to the classes",
					description: "Every core group member, with every date. Ask for a reply so you know who is coming.",
					priority: "medium",
					offsetDays: 5,
				},
				{
					key: "order-materials",
					title: "Order the class materials",
					description: "Order enough for everyone, with time to spare for delivery.",
					priority: "medium",
					offsetDays: 7,
				},
				{
					key: "room-and-childcare",
					title: "Arrange the room and childcare",
					description: "Book the room for every session, and childcare so parents can come too.",
					priority: "medium",
					offsetDays: 10,
				},
				{
					key: "session-one",
					title: "Run session one",
					description: "Start on time, set the tone for the series and take attendance.",
					priority: "medium",
					offsetDays: 14,
				},
				{
					key: "collect-feedback",
					title: "Collect feedback after the first session",
					description: "Ask what worked and what did not while it is fresh, and adjust the next sessions.",
					priority: "low",
					offsetDays: 16,
				},
				{
					key: "chase-absentees",
					title: "Follow up with anyone who missed a session",
					description: "A personal call the same week, with what they missed. One missed session easily becomes two.",
					priority: "medium",
					offsetDays: 21,
				},
			],
		},
		{
			key: "ministry-team-training",
			name: "Ministry Team Training",
			description: "Every team trained on what it will actually do on a Sunday, and a record of who was there.",
			phase: 3,
			category: "training",
			items: [
				{
					key: "training-plan",
					title: "Write the training plan for each team",
					description: "What each team must be able to do on a Sunday, and how long it takes to learn it.",
					priority: "high",
					offsetDays: 5,
				},
				{
					key: "book-training-dates",
					title: "Book the team training dates",
					description: "Book every team's sessions before launch, with room left for a second go if needed.",
					priority: "high",
					offsetDays: 7,
				},
				{
					key: "worship-run-sheet",
					title: "Prepare the worship team run sheet",
					description: "Set list, call time, sound check and cues, on one page the whole team can follow.",
					priority: "medium",
					offsetDays: 12,
				},
				{
					key: "safeguarding",
					title: "Train the children's ministry team on safeguarding",
					description: "Nothing about launch day is more expensive to get wrong. Checks and ratios included.",
					priority: "urgent",
					offsetDays: 14,
				},
				{
					key: "welcome-flow",
					title: "Train greeters and ushers on the welcome flow",
					description: "From the car park to a seat: who stands where, what they say and where guests go next.",
					priority: "medium",
					offsetDays: 16,
				},
				{
					key: "room-plan",
					title: "Train the setup and teardown team on the room plan",
					description:
						"Where everything goes, in what order, and how long it takes. Practise it once against the clock.",
					priority: "medium",
					offsetDays: 18,
				},
				{
					key: "tech-training",
					title: "Train the tech team on sound and slides",
					description:
						"Mixer, microphones and slides, run by more than one person, so one absence does not stop the service.",
					priority: "medium",
					offsetDays: 18,
				},
				{
					key: "all-teams",
					title: "Run a combined all-teams training",
					description: "Walk through a full Sunday together, so each team sees how its part meets the others.",
					priority: "high",
					offsetDays: 25,
				},
				{
					key: "record-completion",
					title: "Record who completed each training",
					description: "A record of who was trained shows which teams are ready and who still needs a session.",
					priority: "low",
					offsetDays: 26,
				},
			],
		},
		{
			key: "small-group-leader-training",
			name: "Small Group Leader Training",
			description: "The model, the material and the first leaders — trained before launch, not after it.",
			phase: 3,
			category: "training",
			items: [
				{
					key: "decide-model",
					title: "Decide the small group model",
					description:
						"Where groups meet, how often, and what they are for. Leaders need the model before the material.",
					priority: "high",
					offsetDays: 3,
				},
				{
					key: "choose-material",
					title: "Choose the first study material",
					description: "Something a new leader can run well, that fits the model and the first few months.",
					priority: "medium",
					offsetDays: 7,
				},
				{
					key: "identify-leaders",
					title: "Identify the first small group leaders",
					description: "People the core group already follows, who can host and care. Ask them personally.",
					priority: "high",
					offsetDays: 10,
				},
				{
					key: "leader-session-one",
					title: "Run leader training session one",
					description: "The model, the material and what a good first evening looks like.",
					priority: "medium",
					offsetDays: 17,
				},
				{
					key: "leader-session-two",
					title: "Run leader training session two",
					description: "Practise leading a discussion, handling the hard moments and when to ask for help.",
					priority: "medium",
					offsetDays: 24,
				},
				{
					key: "assign-coaches",
					title: "Assign each leader someone to report to",
					description: "Every leader has someone to ring when a group gets hard. Name them before the groups start.",
					priority: "medium",
					offsetDays: 26,
				},
				{
					key: "start-date",
					title: "Set the small group start date",
					description:
						"A date gives leaders something to work towards and gives guests a group to join soon after launch.",
					priority: "high",
					offsetDays: 28,
				},
			],
		},
		{
			key: "promotion-campaign",
			name: "Promotion Campaign",
			description: "Getting the launch Sunday in front of the neighbourhood, on paper and on screens.",
			phase: 4,
			category: "promotion",
			items: [
				{
					key: "promotion-budget",
					title: "Agree the promotion budget",
					description:
						"Print, ads and the website, against what you can actually spend. Decide it before anything is ordered.",
					priority: "high",
					offsetDays: 2,
				},
				{
					key: "design-invite",
					title: "Design the invite card",
					description: "Launch date, time, place and one reason to come. Readable at arm's length.",
					priority: "high",
					offsetDays: 7,
				},
				{
					key: "order-invites",
					title: "Order the printed invite cards",
					description:
						"Enough for the neighbourhood drop and for every launch team member, with time to spare for delivery.",
					priority: "high",
					offsetDays: 10,
				},
				{
					key: "launch-page",
					title: "Build the launch page on the website",
					description:
						"Date, time, address, parking and what to expect, with children's details. Guests will look before they come.",
					priority: "high",
					offsetDays: 12,
				},
				{
					key: "social-accounts",
					title: "Set up the social media accounts",
					description:
						"Claim the church name on the platforms your neighbourhood uses, with the same picture and links on each.",
					priority: "low",
					offsetDays: 12,
				},
				{
					key: "write-posts",
					title: "Write four weeks of social posts",
					description:
						"Write and schedule them in one go, counting down to launch, so promotion keeps going in the busy weeks.",
					priority: "high",
					offsetDays: 16,
				},
				{
					key: "hand-out-invites",
					title: "Hand invite cards to the launch team",
					description:
						"Personal invitations bring most first-time guests. Give each person a stack and ask who they will invite.",
					priority: "high",
					offsetDays: 18,
				},
				{
					key: "final-reminder",
					title: "Post the final week reminder",
					description: "One last post and message in launch week, with the time, place and a reason to bring a friend.",
					priority: "urgent",
					offsetDays: 26,
				},
			],
		},
		{
			key: "pre-launch-services",
			name: "Pre-Launch Services",
			description: "Preview services, and the debriefs that make the next one better.",
			phase: 4,
			category: "launch_prep",
			items: [
				{
					key: "set-preview-dates",
					title: "Set the preview service dates",
					description: "Space them so there is time to fix what each one shows before the next.",
					priority: "high",
					offsetDays: 2,
				},
				{
					key: "preview-one",
					title: "Run preview service one",
					description: "Run it as if it were launch Sunday, from setup to teardown, and note what goes wrong.",
					priority: "medium",
					offsetDays: 10,
				},
				{
					key: "debrief-one",
					title: "Debrief preview service one",
					description: "Within two days, with every team leader. What worked, what broke and who fixes it.",
					priority: "high",
					offsetDays: 11,
				},
				{
					key: "fix-what-broke",
					title: "Fix what the debrief found",
					description: "Every item from the debrief gets an owner and a date before the next preview.",
					priority: "medium",
					offsetDays: 14,
				},
				{
					key: "preview-two",
					title: "Run preview service two",
					description: "Check the fixes held, and time every part of the morning against the run sheet.",
					priority: "medium",
					offsetDays: 21,
				},
				{
					key: "debrief-two",
					title: "Debrief preview service two",
					description: "The last chance to change things before launch. Agree what changes and what is good enough.",
					priority: "high",
					offsetDays: 22,
				},
			],
		},
		{
			key: "final-preparation",
			name: "Final Preparation",
			description: "The last checks before launch week, in the order they bite.",
			phase: 4,
			category: "launch_prep",
			items: [
				{
					key: "team-gaps",
					title: "Confirm every team has the people it needs",
					description:
						"Check every team's Sunday rota against the names it has, and fill the gaps now, not on the morning.",
					priority: "urgent",
					offsetDays: 3,
				},
				{
					key: "venue-contract",
					title: "Confirm the venue contract and access times",
					description: "Signed, with the right date and access times. Doors opening late can sink the whole morning.",
					priority: "high",
					offsetDays: 5,
				},
				{
					key: "walk-the-room",
					title: "Walk the room and mark the setup plan",
					description:
						"Walk it with the setup leader and mark where everything goes, so setup follows a plan, not a memory.",
					priority: "high",
					offsetDays: 7,
				},
				{
					key: "test-av",
					title: "Test the sound and video in the room",
					description:
						"In the room you will use, with the equipment you will use. Fix the buzz and the dead socket now.",
					priority: "high",
					offsetDays: 9,
				},
				{
					key: "print-run-sheet",
					title: "Print the launch day run sheet",
					description: "Times, cues and who does what, with a copy for every team leader.",
					priority: "high",
					offsetDays: 12,
				},
				{
					key: "welcome-pack",
					title: "Prepare the welcome pack for guests",
					description:
						"A short welcome, what happens next and how to get in touch. Enough for more guests than you expect.",
					priority: "high",
					offsetDays: 12,
				},
				{
					key: "childcare-checks",
					title: "Confirm childcare ratios and background checks",
					description: "Every volunteer checked and every room staffed to ratio. No exceptions on launch Sunday.",
					priority: "urgent",
					offsetDays: 14,
				},
				{
					key: "brief-leaders",
					title: "Brief every team leader on the run sheet",
					description: "Walk every leader through the run sheet, so each knows their times, their cues and who to ask.",
					priority: "high",
					offsetDays: 16,
				},
				{
					key: "rest",
					title: "Rest the day before launch",
					description: "The work is done. Rest, so you can lead well on the day.",
					priority: "low",
					offsetDays: 20,
				},
			],
		},
		{
			key: "launch-setup-teardown",
			name: "Launch Sunday: Setup & Teardown",
			description: "The trailer, the room and the load-out — the list the setup team works from on the day.",
			phase: 5,
			category: "launch_prep",
			items: [
				{
					key: "load-trailer",
					title: "Load the trailer the night before",
					description: "Load in the reverse order you will unload, and check it against the equipment list.",
					priority: "high",
					offsetDays: 5,
				},
				{
					key: "arrive-and-unload",
					title: "Arrive and unload",
					description:
						"Arrive at the agreed access time and unload to the room plan, so each item lands where it is set up.",
					priority: "urgent",
					offsetDays: 6,
				},
				{
					key: "set-stage",
					title: "Set the stage and seating",
					description:
						"Stage, seating and screens to the marked plan, finished before the band arrives for the sound check.",
					priority: "urgent",
					offsetDays: 6,
				},
				{
					key: "cable-safety",
					title: "Check every power run and cable cover",
					description: "Every cable taped down or covered and every power run checked before the doors open.",
					priority: "high",
					offsetDays: 6,
				},
				{
					key: "load-out",
					title: "Teardown and load out",
					description:
						"Pack against the equipment list so nothing is left behind and the trailer is ready for next week.",
					priority: "high",
					offsetDays: 6,
				},
				{
					key: "return-the-room",
					title: "Return the room to the state you found it in",
					description: "Leave it as you found it. The venue's goodwill is what lets you come back next Sunday.",
					priority: "high",
					offsetDays: 6,
				},
			],
		},
		{
			key: "launch-signage-parking",
			name: "Launch Sunday: Signage & Parking",
			description: "Everything that gets a stranger from the main road to a seat.",
			phase: 5,
			category: "launch_prep",
			items: [
				{
					key: "road-signs",
					title: "Place the road signs",
					description: "From the main roads to the entrance, at every turn a stranger could miss.",
					priority: "high",
					offsetDays: 6,
				},
				{
					key: "car-park-team",
					title: "Brief the parking team",
					description: "Where to stand, where guests park and what to say. Bright jackets and a warm hello.",
					priority: "medium",
					offsetDays: 5,
				},
				{
					key: "guest-parking",
					title: "Mark the guest parking bays",
					description: "Keep the nearest spaces for guests, families and anyone who needs them.",
					priority: "medium",
					offsetDays: 6,
				},
				{
					key: "entrance-signs",
					title: "Place the entrance and welcome signs",
					description: "Point guests to the right door and tell them they are in the right place.",
					priority: "medium",
					offsetDays: 6,
				},
				{
					key: "kids-signs",
					title: "Place the children's check-in signs",
					description: "Parents should find check-in without asking. Put signs at the entrance and along the way.",
					priority: "high",
					offsetDays: 6,
				},
				{
					key: "collect-signage",
					title: "Collect every sign after the service",
					description: "Every sign back in the trailer before you leave, counted against the list.",
					priority: "low",
					offsetDays: 6,
				},
			],
		},
		{
			key: "launch-greeters-ushers",
			name: "Launch Sunday: Greeters & Ushers",
			description: "The first ninety seconds of a guest's experience.",
			phase: 5,
			category: "launch_prep",
			items: [
				{
					key: "greeter-brief",
					title: "Brief the greeters on the welcome flow",
					description: "Who stands where, how to welcome a stranger and where to send them next.",
					priority: "high",
					offsetDays: 5,
				},
				{
					key: "door-positions",
					title: "Set the door positions",
					description: "Someone at every door guests use, in place before the first car arrives.",
					priority: "medium",
					offsetDays: 6,
				},
				{
					key: "welcome-table",
					title: "Stock and staff the welcome table",
					description:
						"Welcome packs, guest cards and a friendly face, staffed before the doors open and after the service.",
					priority: "medium",
					offsetDays: 6,
				},
				{
					key: "guest-cards",
					title: "Put guest cards and pens on every seat",
					description: "One card and a pen on every seat, so every guest can tell you who they are.",
					priority: "medium",
					offsetDays: 6,
				},
				{
					key: "seat-latecomers",
					title: "Agree how latecomers are seated",
					description:
						"Keep a few seats near the back and agree when ushers seat people, so late guests feel welcome, not watched.",
					priority: "low",
					offsetDays: 5,
				},
				{
					key: "hand-in-cards",
					title: "Hand the completed guest cards to assimilation",
					description: "Every card to the assimilation team before you leave, so no guest goes without a follow-up.",
					priority: "high",
					offsetDays: 6,
				},
			],
		},
		{
			key: "launch-childrens-ministry",
			name: "Launch Sunday: Children's Ministry",
			description: "Check-in, ratios and safety — the part of launch day that has no acceptable failure.",
			phase: 5,
			category: "launch_prep",
			items: [
				{
					key: "confirm-volunteers",
					title: "Confirm every children's volunteer and their checks",
					description:
						"Every volunteer confirmed for the day, with current background checks and enough people for the ratios.",
					priority: "urgent",
					offsetDays: 4,
				},
				{
					key: "checkin-system",
					title: "Test the check-in and pick-up system",
					description:
						"Run a family through check-in and pick-up before the doors open. Every child leaves with the right adult.",
					priority: "urgent",
					offsetDays: 5,
				},
				{
					key: "set-rooms",
					title: "Set the children's rooms",
					description: "Safe, clean and ready for each age group, with exits clear and the room plan followed.",
					priority: "high",
					offsetDays: 6,
				},
				{
					key: "supplies",
					title: "Lay out the lesson supplies and snacks",
					description:
						"Lesson materials and allergy-safe snacks laid out in each room before the first family arrives.",
					priority: "high",
					offsetDays: 6,
				},
				{
					key: "allergy-plan",
					title: "Post the allergy and emergency plan in every room",
					description: "Allergies, first aid and the evacuation route, posted where every volunteer can see them.",
					priority: "urgent",
					offsetDays: 6,
				},
				{
					key: "close-rooms",
					title: "Clear the rooms and log the attendance",
					description: "Every child handed back, rooms cleared, and the attendance and any incident written down.",
					priority: "high",
					offsetDays: 6,
				},
			],
		},
		{
			key: "launch-worship-team",
			name: "Launch Sunday: Worship Team",
			description: "Set list, sound check and the run from call time to close.",
			phase: 5,
			category: "launch_prep",
			items: [
				{
					key: "final-set-list",
					title: "Send the final set list to the band",
					description: "Songs, keys and order, sent early enough for the band to practise.",
					priority: "high",
					offsetDays: 4,
				},
				{
					key: "slides",
					title: "Build and proof the lyric slides",
					description:
						"Every lyric checked against the set list and the arrangement. A typo on the screen is a distraction.",
					priority: "medium",
					offsetDays: 5,
				},
				{
					key: "call-time",
					title: "Confirm the call time with every musician",
					description:
						"Every musician confirms the time they arrive. A missing player found at the sound check is too late.",
					priority: "high",
					offsetDays: 5,
				},
				{
					key: "sound-check",
					title: "Run the sound check",
					description: "Every instrument and microphone, finished before the doors open.",
					priority: "urgent",
					offsetDays: 6,
				},
				{
					key: "rehearse",
					title: "Rehearse the full service order",
					description: "Run the whole order, transitions included, so the service flows from start to close.",
					priority: "medium",
					offsetDays: 6,
				},
				{
					key: "pack-down",
					title: "Pack down the stage and instruments",
					description: "Pack instruments and stage gear against the list and hand them to the teardown team.",
					priority: "low",
					offsetDays: 6,
				},
			],
		},
		{
			key: "launch-assimilation",
			name: "Launch Sunday: Assimilation",
			description: "What happens to a guest's card between Sunday lunchtime and Tuesday morning.",
			phase: 5,
			category: "follow_up",
			items: [
				{
					key: "prepare-guest-packs",
					title: "Prepare the guest packs",
					description: "A welcome, what happens next and how to get in touch, ready to hand to every guest.",
					priority: "high",
					offsetDays: 4,
				},
				{
					key: "brief-team",
					title: "Brief the assimilation team on the follow-up promise",
					description: "What you promise every guest, by when, and who makes each call. Then keep it.",
					priority: "high",
					offsetDays: 5,
				},
				{
					key: "collect-cards",
					title: "Collect every guest card after the service",
					description: "Gather every card from the seats and the welcome team before anyone goes home.",
					priority: "urgent",
					offsetDays: 6,
				},
				{
					key: "enter-guests",
					title: "Enter each guest into Everyfield the same day",
					description: "Every guest card in Everyfield before the day ends, so follow-up starts from a full list.",
					priority: "urgent",
					offsetDays: 6,
				},
				{
					key: "thank-you-message",
					title: "Send the thank-you message to every guest",
					description: "Within two days, personal and short. Thank them for coming and invite them back.",
					priority: "urgent",
					offsetDays: 7,
				},
				{
					key: "invite-to-next-step",
					title: "Invite each guest to a next step",
					description: "A small group, a team or a coffee. One clear next step, offered personally.",
					priority: "high",
					offsetDays: 9,
				},
			],
		},
		{
			key: "first-90-days-rhythms",
			name: "First 90 Days Rhythms",
			description: "The repeating work that turns a launch into a church: guests, leaders, money and the next group.",
			phase: 6,
			category: "recurring",
			items: [
				{
					key: "service-planning",
					title: "Set the weekly service planning meeting",
					description: "Same time every week. Review last Sunday, plan the next and fix what needs fixing.",
					priority: "high",
					offsetDays: 1,
				},
				{
					key: "guest-followup-standard",
					title: "Agree the 48-hour first-time guest follow-up standard",
					description:
						"Every first-time guest hears from someone within 48 hours. Agree who does it and check it happens.",
					priority: "urgent",
					offsetDays: 2,
				},
				{
					key: "leaders-meeting",
					title: "Set the monthly leaders meeting",
					description: "Once a month, every leader together: how teams are doing, what is coming and who needs help.",
					priority: "medium",
					offsetDays: 3,
				},
				{
					key: "finance-review",
					title: "Set the monthly giving and expenses review",
					description: "Giving against spending each month, so the budget stays real and surprises stay small.",
					priority: "medium",
					offsetDays: 7,
				},
				{
					key: "coach-review",
					title: "Book the three-month review with your coach",
					description: "Three months in, look back with your coach at what is working and what to change.",
					priority: "high",
					offsetDays: 14,
				},
				{
					key: "next-small-group",
					title: "Start the next small group",
					description: "New guests need somewhere to belong. Start the next group before the first ones fill.",
					priority: "medium",
					offsetDays: 30,
				},
				{
					key: "first-baptisms",
					title: "Plan the first baptism service",
					description: "Set the date, talk with each candidate and invite their family and friends.",
					priority: "medium",
					offsetDays: 45,
				},
			],
		},
	],
};
