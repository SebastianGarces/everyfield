# Evry use by Discovery accounts

A free Discovery account can ask Evry `EVRY_DISCOVERY_DAILY_QUESTIONS` questions a day (default 30, D-3098). The day
starts at 00:00 in the account's personal time zone, or 00:00 UTC when it has none (D-3099). A question is one planter
message Evry accepts in a Discovery conversation; a retry of the same message, a repeated request and a refused message
do not count (D-3100). A question over the limit is refused before anything is saved, with no model call and no spend, and the
planter sees "You've reached today's Evry questions. They'll be back tomorrow. Everything else in Discovery stays
open." Church, sending church and network conversations are never limited. The monthly cap `EVRY_MONTHLY_CAP_USD`
(D77) still applies to every call. The decision is D109 in `docs/architecture/decisions.md`.

## Change the limit

Set `EVRY_DISCOVERY_DAILY_QUESTIONS` in the deployment's server environment to a whole number (0 turns Discovery
questions off). It takes effect on the next request, with no code change. Anything that is not a whole number of 0 or
more keeps the default 30.

## Measure use

The query below reads the database and changes nothing. It lists, per account and day, the questions counted and the
estimated model cost in USD: the D77 reserve-and-settle charge (`usage.costMicroUsd`) of every answer, retries
included, started in the account's Discovery conversations that day. An answer still running has no cost yet.

```sql
SELECT q.account_id, q.day::text AS day, q.questions,
	round(coalesce(sum((s.body->'usage'->>'costMicroUsd')::bigint), 0) / 1000000.0, 6) AS estimated_cost_usd
FROM evry_question_day q
JOIN account a ON a.id = q.account_id
LEFT JOIN conversation c ON c.account_id = q.account_id AND c.tenant_id = q.account_id AND c.context_kind = 'account'
LEFT JOIN conversation_event m ON m.conversation_id = c.id AND m.kind = 'user_message'
	AND (m.created_at AT TIME ZONE coalesce(a.personal_timezone, 'UTC'))::date = q.day
LEFT JOIN conversation_event s ON s.conversation_id = m.conversation_id AND s.turn_id = m.turn_id AND s.kind = 'status'
GROUP BY q.account_id, q.day, q.questions
ORDER BY q.day DESC, q.questions DESC
```

Run it with a read-only connection to the shared development database. Production is production access: AGENTS guard 1
applies, so get Sebastian's OK first.
