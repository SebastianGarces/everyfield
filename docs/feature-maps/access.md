# Feature map: access

Generated from [`apps/web/src/features/access/feature-map.json`](../../apps/web/src/features/access/feature-map.json) by `node tools/ci/feature-maps.ts --write`. Do not edit by hand.
Personas, sign-in and what the checker cannot catch: [README](README.md).

```mermaid
flowchart LR
  s0_link0(["link /design/access/{flow}"])
  s0["access.design-preview<br/>/design/access/[flow]"]
  s0_link0 --> s0
  s0 -.- s0_st0(("staff-notes"))
  s0 -.- s0_st1(("pending"))
```

## Surfaces

### access.design-preview

Design previews of the access boundary pages and the staff notes panel by viewer duty, with sample data and no database.

- Routes: `/design/access/[flow]`
- Personas: `visitor` read

Reach:

- Link `/design/access/{flow}` where `{flow}` is not-available, session-ended, pending or staff-notes

States:

- **staff-notes**: radiogroup "Preview as"; heading "Staff notes"; button "Show more notes". As `visitor`, on the QA seed:

```bash
agent-browser open "$ORIGIN/design/access/staff-notes"
agent-browser wait --load networkidle
agent-browser find role radiogroup text --name "Preview as" --exact
agent-browser find role heading text --name "Staff notes" --exact
agent-browser find role button text --name "Show more notes" --exact
```

- **pending**: heading "Finish setting up"; link "Set up your church". As `visitor`, on the QA seed:

```bash
agent-browser open "$ORIGIN/design/access/pending"
agent-browser wait --load networkidle
agent-browser find role heading text --name "Finish setting up" --exact
agent-browser find role link text --name "Set up your church" --exact
```

