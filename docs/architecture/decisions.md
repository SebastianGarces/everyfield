# Architecture decisions

These are owner and coordinator decisions for the current build. Requirements and acceptance cases define product behavior. [EveryField patterns](intent://local/note/df294729-367b-493b-9faf-654cf6b25b62) supplies default implementation choices.

## D70, 2026-10-19: behavior and mechanism authority

Requirements and acceptance cases describe the product end state. Builders use the current EveryField patterns for mechanisms and explain any product reason for a deviation in the PR. Audit records, safe retries, conflict detection, privacy and recoverable side effects remain required behaviors.

## D73, 2026-10-19: migrations before customer launch

Sebastian confirmed that the product has no customers yet. Until launch to real customers, schema changes and their production migrations need no separate owner approval. Preserve the early-access tables and their rows, which contain real sign-ups from the WP-097 site. Revisit this rule when the product ships to real customers.

This decision changes migration approval only. Existing spending, credential, deployment and merge authority still applies.
