<!--
Everyfield PR body template. Copy everything below this comment into the PR body.

This file is the only list of required PR sections. Each level-2 heading ("## ") is one
required section. A PR body must contain each heading with the exact text, in this order,
and each section must have content other than these comments. Level-3 headings are optional.
Tools read the headings from this file: change a section here, not in the tool.

Replace every comment with your text. Delete the comments when you are done.
-->

## Summary

<!--
Two to four plain sentences for Sebastian. Say what a person can now do, see or rely on that
they could not before. Name the task (WP-NNN or OPS-n). No file names, no code names, no jargon.
-->

## What changed and why

<!--
One short paragraph or a few bullets per change. For each change, say what changed and the
reason. Link the task note, clause or decision that asked for it. Add one small diagram, file
tree or diff sketch if it makes the shape clear (see the upstream `pr` skill for the options).
List any ruling you made yourself and why.
-->

## How it was verified

<!--
Show what you ran and what you saw. Give each check, its result and the commit it ran on.

UI change: before (main) and after (branch) screenshot or video links, in Chromium and WebKit.
Store media outside the repository and link to it.

Backend or tooling change: the script or command you ran and the relevant lines of its output,
before and after when a before exists.

Say who verified it (author, or verifier of the other model family) and on which preview.
-->

## Risks and accepted exceptions

<!--
Door: one-way (hard to undo, for example a data migration or an external setting) or two-way
(a revert undoes it).
Blast radius: what else could break, and for whom.
Accepted exceptions: each check you skipped or rule you did not follow, why, and who accepted it.
Write "None" for a part that has nothing.
-->

## Follow-ups

<!--
Work this PR does not do, each with its task link or "no task yet". Write "None" if there is none.
-->

<!--
Machine lines. Keep them after the last section and outside the human sections.
EVF-Author: your model family, `anthropic` (Opus), `xai` (Grok Build) or `openai` (Sol). evf ship reads it.
The attribution line your host requires comes last, after EVF-Author.
-->
EVF-Author: <family>
