const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'not', 'but', 'has', 'have', 'its', 'into', 'when', 'then', 'than',
  'error', 'exception', 'failed', 'fail', 'undefined', 'null', 'none', 'true', 'false', 'return', 'function', 'cannot', 'expected',
  'received', 'at', 'in', 'of', 'to', 'is', 'it', 'on', 'be', 'an', 'as', 'by', 'or', 'sometimes', 'users', 'user',
]);

/** Split camelCase / snake_case / paths into lowercase word stems. */
export function tokenize(text: string): string[] {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()
    .split(' ');
  const out: string[] = [];
  for (let w of words) {
    if (w.length < 3 || STOP.has(w)) continue;
    if (w.length > 4 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

export const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export function ago(iso: string, nowMs = Date.now()): string {
  const d = (nowMs - Date.parse(iso)) / 86_400_000;
  if (d < 1 / 24) return 'just now';
  if (d < 1) return `${Math.floor(d * 24)}h ago`;
  if (d < 60) return `${Math.floor(d)}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export function ageDays(iso: string, nowMs = Date.now()): number {
  return (nowMs - Date.parse(iso)) / 86_400_000;
}
