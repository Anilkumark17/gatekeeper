---
name: gatekeeper
description: Use when implementing a feature or change in a codebase that has a .gatekeeper/ store, and when debugging something that broke in it. Captures why code is the way it is while building, and ranks which past decisions could explain a bug while debugging. Fires on "add/implement/build/refactor X" and on "why is X failing / sometimes broken / regressed since the deploy".
---

# GateKeeper

GateKeeper keeps a live graph of the code (derived, rebuildable) and a record of intent (irreplaceable: what you built, what you chose, what you rejected, what must stay true). Intent exists only while you work. Capture it at the moment you write the code.

**Interface.** If MCP tools `gk_*` are available use them. Otherwise run the `gk` CLI (JSON on stdout). Both map one to one: `gk_context` = `gk context`, and so on. The developer's editor panel updates from the same files, so every call you make is visible to them live.

Never read the whole repo. Work from `gk context`.

## BUILD MODE

1. **Context first.** `gk context --task "<the request>"`. Work from the pack. Open a file only when the pack's hop-0 source is truncated or missing what you need. Note any `?` edges: static analysis could not resolve them (dynamic dispatch, DI, event bus, ORM, cross-service). Treat them as unknown, not absent.

2. **Decompose into 3 to 7 subtasks.** Each is a unit of the change (a thing the code now does or a module that now exists), never a step of your own process. Good: "Rate limit counter per API key", "Quota check in request middleware". Bad: "Read the files", "Write tests", "Think about edge cases".
   `gk plan --feature "<name>" --task "<A>" --task "<B>" ...`
   The panel renders the tree the moment this runs.

3. **One interruption.** Say exactly: `Edit any of these in the panel, re-prompt, or say go.` Then stop and wait. This is the only wait in the mode.
   - Small correction from the developer: apply it (`gk edit --id ST-002 --title "..."`, or `gk remove --id ST-003`) and proceed without asking again.
   - Different shape: `gk plan --feature "<name>" --replace --task ...` and redecompose from scratch.
   - If the developer removed or renamed subtasks in the panel, `gk tree` shows the current plan. The tree on disk is the truth, not your memory of it.

4. **Implement in order.** One line per subtask when you start it. No narration between.

5. **Record immediately after each subtask's code is written. Never batch at the end.** Batching is how decisions get lost, which is the one thing this product exists to prevent.
   ```
   gk record --id ST-002 --status done \
     --symbol "src/quota.ts:checkQuota" --symbol "src/quota.ts:bumpCounter" \
     --assumes "the counter key includes the API key id, not the user id" \
     --chose "fixed 60s window" --rejected "sliding window" \
     --why "no extra storage round trip" --by agent
   ```
   `--symbol` takes `<module path>:<qualified name>` or a bare name that is unambiguous. Record every symbol you created or materially changed. If you rename a symbol later, intent follows it automatically at the next sync.

6. **Decisions.** At most one decision question per run, and only when two reasonable approaches exist and the choice is costly to reverse. Give two options, one line of tradeoff each, and a named default. A second decision point: take it yourself and record it with `--by agent`. If the developer chose, record `--by developer`.

### What `--assumes` means

`--assumes` records what must stay **TRUE** for the code to keep working. It is not a description of what the code does. Nothing enforces this mechanically, so you must.

Good (conditions that can become false):
- "the sort is stable across pages, so cursors do not skip rows"
- "a 60s stale read of the user's plan is acceptable to every caller"

Bad (descriptions):
- "caches the user lookup"
- "loops over the items and filters the expired ones"

Test: if the sentence stays true after a teammate rewrites the function, it is a description. If a teammate could break the system without touching this function by changing something it relies on, it is an assumption. A subtask with no real assumption gets no `--assumes`; do not invent one.

## DEBUG MODE

**Never read the codebase first.**

1. Extract terms and symbols from the symptom: exception names, function names, file paths, domain nouns. Include stack frames verbatim.
2. `gk suspects --error "<symptom or stack trace>" --term <noun> --symbol <name>`
3. Do the thing the CLI cannot: **test each suspect's assumption against the symptom.** The score is lexical and structural. It cannot tell whether an assumption explains the symptom.

The response has three bands:
- `suspects`: top scored.
- `also_considered`: every lower scored record that still carries an assumption, with full fields.
- `cleared`: ids only.

**`also_considered` exists so a low scoring record can be promoted on assumption grounds. Promoting one is expected, not exceptional.** A subtask whose assumption is exactly the cause scores near zero when its vocabulary does not overlap the error text. You can only promote what the CLI returns, so read every entry in `also_considered`.

### Heuristics: symptom shape implicates assumption kind

- "Sometimes", "intermittent", "under load", "flaky", "only in prod": caching, races, shared mutable state, stale reads, ordering, timeouts.
- "Only some users", "only under the limit", "off by one", "the 101st": counters, boundaries, pagination, rounding, window edges.
- "Since the deploy", "started yesterday", "regressed": weight recent records and `drifted: true` entries up. Drift means the code changed after the assumption was recorded.
- "Wrong data but no error": transformations, units, timezones, nullability assumptions.
- "Works locally": config, environment, ordering of startup, unresolved (`?`) edges such as DI and event buses.

### Present two or three candidates. Never a single verdict.

For each: the assumption, why it fits this symptom, and a **Check** line naming the cheapest action that discriminates it from the others (a log line, a one-line repro, a config flip). Example:

> **ST-004** assumes "a 60s stale read of the plan is acceptable". Fits: the failure is intermittent and clears on retry. **Check:** call the endpoint twice within 60s after changing the plan; a stale value confirms it.

The panel lights the same candidates. The developer clicks Check, which writes to `outcomes.jsonl`. If the developer tells you the result in chat instead, log it: `gk check --id ST-004 --result confirmed|cleared`.

## DEGRADATION

- **Empty store** (no `.gatekeeper/` or no intent records): say so in one line, debug normally with the code, and offer once to start recording. Do not offer again.
- **True cause outside the record**: say plainly "the record missed this" and run `gk miss --note "<what the cause was>"`. A tool that hides its misses cannot be evaluated, and the meta loop depends on those misses being logged.
- **Orphaned or drifted symbols** in `gk tree`: say so. The assumption may be stale; check it against the current code before trusting it.

## Housekeeping

- `gk verify` after a refactor: reports orphan rate (intent attached to symbols that no longer exist) and drift rate.
- `gk meta` is for the developer, on demand. It may write a weight proposal; never accept one yourself.
- Never edit `.gatekeeper/*.jsonl` by hand. They are append-only logs.
