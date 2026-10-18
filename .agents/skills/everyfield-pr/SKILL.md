---
name: everyfield-pr
description: "Apply when writing or reviewing an EveryField PR body. Fill template.md so Sebastian can read what changed, why, and how it was verified without opening the code."
---

# EveryField PR body

Sebastian reads the PR body, often after an automatic merge, and usually without opening the code.
The body is the record of what changed and how we know it works. Write it for him.

## Base skill

The upstream `pr` skill (`.agents/skills/pr/SKILL.md`, verbatim, do not edit) supplies the visual
menu for showing a change: pseudocode, call trees, file trees, Mermaid and diff sketches. It also
supplies the evidence tiers and the door and blast radius ideas. Use those inside the sections below.
Where the two skills differ, this skill wins. The upstream skill points to `GLOSSARY.md`. EveryField
has no glossary file: use the terms from the task brief and `docs/product/`.

## Required sections

[template.md](template.md) is the only list of required sections for ordinary PRs. Each level-2
heading in it is a required heading in the PR body, with the exact text and in the same order.
Wiki article and prototype PRs use their class templates instead:
`tools/evf/templates/wiki-pr.md` and `tools/evf/templates/prototype-pr.md`. evf selects the class
from the PR's branch, labels and changed files. Tools read these files. To change a standard,
change its template in a reviewed PR. Do not copy a heading list into another file or tool.

Copy the template, replace each comment with your text, and delete the comments. A section with
only a comment counts as empty.

## How to write each section

- **Summary.** Plain words. What can a person now do, see or rely on? Name the task ID. If Sebastian
  reads only this section, he still knows what merged.
- **What changed and why.** Pair each change with its reason and a link to what asked for it.
  Use at most one or two visuals from the upstream skill. List rulings you made yourself.
- **How it was verified.** Evidence, not claims. UI: before (main) and after (branch) screenshots or
  video in Chromium and WebKit. Backend and tooling: the command and the lines of output that prove
  the point. Give the commit SHA each check ran on and who ran it.
- **Risks and accepted exceptions.** Say one-way or two-way door. Name the blast radius. List every
  skipped check or bent rule with the reason and the person who accepted it.
- **Follow-ups.** Each open item with a task link, or "None".

## Rules

- Keep evidence files out of the repository. Link to media stored outside it.
- Write short sentences in the active voice. Explain a technical term the first time, or drop it.
- Do not paste credentials, tokens or connection strings, even partly.
- After the last section, add one line `EVF-Author: anthropic` or `EVF-Author: openai` for your
  model family. evf ship uses it to refuse a review from the same family. Then end the body with
  the attribution line your host requires.

## Check before you open the PR

1. Every heading from template.md is present, exact, in order, and has real content.
2. The summary makes sense to someone who has not read the task.
3. Each verification claim has a link or an output excerpt and a commit SHA.
4. No comment from the template is left in the body.
