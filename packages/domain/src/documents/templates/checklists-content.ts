export type ChecklistTeam = { id: string; name: string; tasks: string[] };

/** Six teams, five tasks each. Owners, times and team leads are filled in by the church. */
export const CHECKLIST_TEAMS: ChecklistTeam[] = [
	{
		id: "setup",
		name: "Setup",
		tasks: [
			"Unlock doors and turn on the lights",
			"Set out the chairs in rows",
			"Hang the welcome banner at the street entrance",
			"Test the projector, screen and slides",
			"Walk the room with the launch-day map",
		],
	},
	{
		id: "hospitality",
		name: "Hospitality",
		tasks: [
			"Brew coffee and set out tea and water",
			"Place directional signs outside",
			"Prepare name tags and a guest welcome table",
			"Brief greeters: smile, say a name, walk guests to a seat",
			"Check restrooms and refill supplies",
		],
	},
	{
		id: "worship",
		name: "Worship",
		tasks: [
			"Load the stage and run the sound check",
			"Tune instruments and check monitors",
			"Confirm the song order and lyric slides",
			"Rehearse the opening song and transitions",
			"Pray with the team before doors open",
		],
	},
	{
		id: "kids",
		name: "Kids",
		tasks: [
			"Set up the safe check-in desk and name labels",
			"Stock each room with the lesson and craft supplies",
			"Hand out volunteer badges and room assignments",
			"Review the allergy and pickup procedure",
			"Open rooms and greet the first families",
		],
	},
	{
		id: "connections",
		name: "Connections",
		tasks: [
			"Set up the connect table with a card and pen for each guest",
			"Post the QR code for the next-steps form",
			"Print the handout: groups, serving and giving",
			"Assign a host to each first-time guest",
			"Collect the cards and enter them by noon",
		],
	},
	{
		id: "prayer",
		name: "Prayer",
		tasks: [
			"Open the prayer room and set out prayer cards",
			"Walk and pray over the room, row by row",
			"Brief the prayer team on how to listen and pray with guests",
			"Stand ready at the front during the final song",
			"Log answered prayers for the church plant newsletter",
		],
	},
];

export const CHECKLIST_TITLE = "Launch Sunday Checklists";
export const CHECKLIST_INSTRUCTION =
	"Check each task when it is done. Each owner confirms by the time written beside it, so the whole church plant team is ready together.";
