// GateKeeper hook. `prompt` runs on every user prompt, `edit` runs before every file write.
// Only touches .gatekeeper/gate.json; no dependencies so it starts fast.
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2];
let input = {};
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  /* no payload: do nothing */
}

function findStore(start) {
  let d = path.resolve(start || process.cwd());
  for (;;) {
    if (fs.existsSync(path.join(d, '.gatekeeper'))) return path.join(d, '.gatekeeper');
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

const dir = findStore(input.cwd);
if (!dir) process.exit(0);
const gateFile = path.join(dir, 'gate.json');

if (mode === 'prompt') {
  const prompt = String(input.prompt ?? '').trim();
  if (!prompt || prompt.startsWith('/')) process.exit(0);
  fs.writeFileSync(gateFile, JSON.stringify({ pending: true, allowed: null, ts: new Date().toISOString() }));
  console.log(
    'GateKeeper is on. Before writing any code: call gk_context, then gk_plan with 3 to 7 subtasks. ' +
      'Give each subtask nodes (file or file:symbol, one-line note). Then stop and tell the developer to approve ' +
      'the first subtask in the GateKeeper panel. For each approved subtask call gk_next, implement only that, ' +
      'then gk_record it. File edits are blocked until the developer approves.',
  );
  process.exit(0);
}

if (mode === 'edit') {
  const target = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '');
  if (target && path.resolve(target).startsWith(dir + path.sep)) process.exit(0); // the store itself
  let gate = { pending: false, allowed: null };
  try {
    gate = JSON.parse(fs.readFileSync(gateFile, 'utf8'));
  } catch {
    process.exit(0); // never prompted under GateKeeper: stay out of the way
  }
  let reason = '';
  if (gate.pending) reason = 'GateKeeper: no plan yet for this prompt. Call gk_plan first, then wait for approval in the panel.';
  else if (!gate.allowed) reason = 'GateKeeper: no subtask approved. Ask the developer to press Approve on the current subtask in the GateKeeper panel.';
  if (reason) {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }));
  }
}
