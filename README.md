# GateKeeper

A reasoning harness for AI coding agents.

GateKeeper keeps two things side by side, joined on symbol names:

- **Structure**: a live graph of your code (modules, classes, functions, calls, imports). It is rebuilt from source whenever you save.
- **Intent**: a record of what the agent built and why (the decision it took, what it rejected, and the assumptions the code rests on). This exists only while the agent works, so GateKeeper captures it as it happens.

When something breaks, GateKeeper ranks which past decisions could explain the bug. Everything shows up inside VS Code (hovers, CodeLens, a side panel). Nothing opens in a browser.

## What you get

| Part | What it is | Who uses it |
|---|---|---|
| Claude Code plugin | Skill + MCP server (12 `gk_*` tools) | Claude Code (the agent) |
| `gk` CLI | Same operations on the command line, JSON output | Agents without MCP, CI, you |
| VS Code extension | Panel, gutter icons, hovers, CodeLens, suspect highlights | You |

Languages: TypeScript, JavaScript, Python.

---

## Install

Requirements: Node.js 20 or newer, git. VS Code 1.93 or newer for the extension.

### Step 1. Add the plugin to Claude Code

```bash
claude plugin marketplace add Anilkumark17/gatekeeper
claude plugin install gatekeeper@gatekeeper-marketplace
```

Check it with `claude plugin list`. It should show `gatekeeper@gatekeeper-marketplace` as enabled.

Add `--scope project` to the install command to share it with your team through the project's settings.

### Step 2. Set up a project

Open the project in Claude Code and run:

```
/gatekeeper:init
```

This creates a `.gatekeeper/` folder and builds the first graph. Commit `.gatekeeper/` (the `cache/` folder inside it is git-ignored). `intent.jsonl` is the one file that cannot be regenerated.

### Step 3. Install the VS Code extension (optional, for the panel)

The extension is not on the marketplace yet, so build it from source:

```bash
git clone https://github.com/Anilkumark17/gatekeeper.git
cd gatekeeper
npm install
npm run build
cd packages/vscode
npx @vscode/vsce package --no-dependencies --allow-missing-repository
code --install-extension gatekeeper.vsix
```

Reload VS Code. In a project that has `.gatekeeper/`, the status bar shows `GK <n> nodes`. In a project without it, the status bar shows `GateKeeper: set up`; click it to initialize.

### Step 4. Install the CLI (optional)

```bash
# from the cloned repo
npm install -g ./packages/cli ./packages/mcp
cd your-project
gk init --mcp
```

`gk init` creates `.gatekeeper/` and copies the skill into `.claude/skills/`. With `--mcp` it also registers the MCP server in `.mcp.json`. Use this path if you do not use the Claude Code plugin.

---

## Run it

### Build mode (implementing a feature)

Ask Claude Code to implement something. The skill makes it do this:

1. Call `gk_context` and work from the budgeted context pack instead of reading the repo.
2. Split the work into 3 to 7 subtasks with `gk_plan`. The plan appears in the panel's **Tree** tab at once.
3. Ask you once: *Edit any of these in the panel, re-prompt, or say go.*
4. Implement, and call `gk_record` right after each subtask with the symbols, the **assumptions**, what it chose, and what it rejected.

An assumption is something that must stay true for the code to keep working ("the sort is stable across pages"), not a description ("caches the lookup").

### Debug mode (something broke)

Describe the symptom, or let GateKeeper pick it up:

- Run **GateKeeper: Rank Suspects for Symptom…** from the command palette.
- Or copy an error and run **GateKeeper: Rank Suspects from Clipboard**.
- Or fail a command in the VS Code terminal and click **Rank suspects** on the prompt.

You get three bands:

- **likely**: top scored.
- **possible**: lower scored but they record an assumption, so they can still explain the bug.
- **cleared**: shown dimmed in the graph, never hidden.

Test each candidate's assumption, then click **Check** in the panel (or run `gk check --id ST-001 --result confirmed`). Results go to `outcomes.jsonl`.

### In the editor

| Do this | You get |
|---|---|
| Press `Ctrl+Alt+G` | Panel opens beside the editor |
| Click a graph node | Editor jumps to that symbol |
| Move the cursor | Graph focus follows it |
| Hover a symbol name | Its assumption, decision, rejected option, author, and age |
| Look above a function | CodeLens such as `3 dependents · 1 assumption` |
| Double-click a node | Re-center the graph on it |

The Tree tab is live. Removing a subtask (the × button or `gk remove --id ST-002`) drops it from the tree. Editing code marks recorded symbols as "changed since recorded". Deleted symbols show as "missing". Renamed symbols keep their intent.

---

## CLI reference

All commands print JSON, and `gk tree --human` prints a readable tree. In Claude Code the same operations are the `gk_*` MCP tools.

```
gk init [--mcp]                                  set up the project
gk plan --feature X --task A --task B [--replace]
gk record --id ST-001 --status done --symbol S --assumes A --chose C --rejected R --why W --by agent
gk tree [--feature X] [--human]
gk remove --id ST-001 | --feature X
gk edit --id ST-001 [--title T] [--feature F]
gk context --task "..." | --symbol S             budgeted context pack (about 8k tokens)
gk suspects --error "..." [--term T] [--symbol S]
gk check --id ST-001 --result confirmed|cleared
gk miss --note "the true cause was not in the record"
gk verify [--max-orphan-rate 0.1]                orphan rate and drift rate (exit code 2 if over)
gk meta [--accept FILE | --reject FILE]          ranking quality report
gk sync                                          rebuild the graph now
```

`gk verify --max-orphan-rate 0.1` works as a CI check.

---

## What is stored

Everything lives in `.gatekeeper/` at the project root.

| File | Notes |
|---|---|
| `structure.json` | The graph. A cache you can delete; it is rebuilt from source. |
| `intent.jsonl` | Append-only log of plans, records, edits, removals, and renames. Cannot be regenerated. |
| `outcomes.jsonl` | Append-only log of every suspect query, every Check, every logged miss. |
| `cache/` | Per-file parse results keyed by content hash. Git-ignored. |
| `config.json` | Optional `include` and `exclude` globs. Your excludes are added to the safe defaults. |
| `weights.json` | Exists only after you accept a ranking proposal from `gk meta`. |

Symbol ids look like `src/quota.ts:checkQuota` (module path, colon, qualified name). They never contain line numbers, so they survive edits.

---

## Develop and test

```bash
npm install
npm run build            # builds CLI, MCP server, extension, and plugin
npm test                 # unit tests for the core
npx tsx scripts/verify.ts <repo> "<task description>"    # timings, graph stats, ranking test
npm run e2e -- <repo>    # drives a real VS Code window: failing test -> suspect -> hover -> Check
```

`verify.ts` and the end-to-end test change files in the target repo temporarily, so point them at a throwaway clone.

After changing code, rebuild the plugin and push it. Installed copies only update from what is committed in `plugin/`:

```bash
node scripts/build.mjs plugin
git add -A && git commit -m "update" && git push
```

Layout:

```
packages/core      graph engine and context store
packages/cli       gk
packages/mcp       MCP server
packages/vscode    extension
plugin/            built Claude Code plugin (committed)
.claude/skills/gatekeeper/SKILL.md
```

To add a language, write one parser file in `packages/core/src/parsers/` and register it with one line in `parsers/index.ts`.

---

## Limits

- Static parsing cannot resolve dynamic dispatch, dependency injection, event buses, ORM calls, or cross-service calls. Those appear as dashed "unresolved" nodes and edges, never silently omitted. Python has more of them (about 31% of edges in a 17k-line test repo) than TypeScript (about 1%).
- Churn in the ranking is counted per file, not per symbol.
- The ranking score uses words and graph distance only. It never filters out a record that carries an assumption; the agent decides whether an assumption actually explains the symptom.
- `gk meta` may write a weights proposal. Nothing changes until you accept it.

## License

MIT
