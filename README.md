# GateKeeper

Editor-native reasoning harness for AI coding agents. A live graph of the codebase (derived) joined, on symbol identity, to a record of what the agent built and why (irreplaceable). Both surface inside VS Code. Nothing opens in a browser.

```
packages/core     context store + graph engine (TypeScript, tree-sitter wasm, no native build)
packages/cli      gk: for the agent and for CI
packages/mcp      the same operations as an MCP server, for any MCP-capable agent
packages/vscode   extension: panel, gutter icons, hovers, CodeLens, debug highlights
.claude/skills/gatekeeper/SKILL.md   the build/debug protocol the agent follows
```

## Install in any project

```bash
npm install && npm run build          # once, in this repo
npm install -g ./packages/cli ./packages/mcp   # puts `gk` and `gatekeeper-mcp` on PATH

cd your-project
gk init --mcp      # creates .gatekeeper/, installs the skill into .claude/skills/, registers the MCP server in .mcp.json
```

Editor: `cd packages/vscode && npx @vscode/vsce package --no-dependencies` then install the `.vsix`
(`code --install-extension gatekeeper.vsix`). The status bar shows `GateKeeper: set up` in a project without `.gatekeeper/`.

Commit `.gatekeeper/` (the `cache/` folder is git-ignored). `intent.jsonl` is the part you cannot regenerate.

## What lives in `.gatekeeper/`

| file | lifetime | notes |
|---|---|---|
| `structure.json` | derived cache | nodes and edges keyed by symbol id `<module path>:<qualified name>`, never line numbers |
| `intent.jsonl` | irreplaceable, append only | event log: `plan`, `record`, `edit`, `remove`, `rename`. Current state is a fold of the log, so removing a subtask in the panel writes a tombstone instead of rewriting history |
| `outcomes.jsonl` | append only | every `suspects` query, every Check, every logged miss |
| `cache/` | disposable | per-file parse results keyed by content hash |
| `weights.json` | optional | only exists after you accept a meta-loop proposal |

## Using it

**Build mode** (agent): `gk context --task "..."` → `gk plan` → say `go` → implement → `gk record` after each subtask.
**Debug mode** (agent): `gk suspects --error "..."` → test each assumption → present 2 or 3 candidates with a Check line.
**You**: open the panel (`Ctrl+Alt+G`), click a node to jump to code, move the cursor to move the graph focus. Run *GateKeeper: Rank Suspects…* or fail a command in the terminal and accept the prompt.

The tree is live. `gk remove --id ST-003` (or the × in the panel) drops it from the tree. Editing code on disk (you, or the agent) reparses that file, flags recorded symbols whose body changed ("changed since recorded"), and shows symbols that disappeared as missing. A rename is detected at the next outer loop and intent follows it.

## The three loops

| loop | trigger | ceiling | does |
|---|---|---|---|
| inner | file save, or any on-disk change | 300 ms | reparse one file from cache, relink it and its importers, refresh decorations, send a graph delta. Never touches intent. Heavy files are marked stale and finished on idle |
| outer | commit (`.git/logs/HEAD`), `gk sync`/`gk verify`/`gk record`, command | 30 s | rebuild changed files, diff against the last snapshot, repair renames, report orphans |
| meta | `gk meta` | none | hit@1, hit@3, signal distribution; writes a weights **proposal**. You accept with `gk meta --accept <file>` |

## Honest limits

- Static parsing cannot resolve dynamic dispatch, DI, event buses, ORM calls, cross-service calls. Those become `resolved: false` nodes/edges (dashed in the panel). Method calls on values of unknown type are matched by method name only when the name is rare in the project, and are marked unresolved.
- Churn is file level (commits touching the symbol's file in 30 days), not symbol level.
- The ranking score is lexical and structural. By design it never filters: any record carrying an assumption stays promotable in `also_considered`. Whether an assumption explains the symptom is the agent's job.
- Languages: TypeScript, JavaScript, Python. A fourth language is one file in `packages/core/src/parsers/` plus one line in `parsers/index.ts`.

## Develop

```bash
npm test                                   # core unit tests
npx tsx scripts/verify.ts <repo> "<task>"  # phase 6 numbers + the ranking test (mutates the repo temporarily; use a clone)
node packages/vscode/test/e2e/run.mjs <repo>   # drives the real editor: failing test → suspect → hover → Check
```
