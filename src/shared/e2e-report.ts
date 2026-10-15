// Live-readiness report (REVIEW-2 #1): what `npm run e2e:live` measured.
// Pure, so the report format is unit-tested without a backend.

export interface TaskResult {
  id: string;
  prompt: string;
  status: 'pass' | 'fail' | 'error' | 'skipped';
  /** ms from send to the first streamed text / first tool call / done. */
  firstTextMs?: number;
  firstToolMs?: number;
  doneMs?: number;
  tools: string[];
  confirms: number;
  /** Tool names the backend used that are not Cadabra's (must be empty). */
  foreignTools: string[];
  reply: string;
  note?: string;
}

export interface LiveReport {
  provider: string;
  startedAt: string;
  status: 'completed' | 'skipped';
  skipReason?: string;
  auth?: string;
  isolation?: string;
  tasks: TaskResult[];
}

export const CADABRA_TOOLS = new Set([
  'see_screen', 'read_ui', 'highlight', 'click', 'type_text', 'press_keys', 'scroll', 'confirm_with_user',
  'find_apps', 'launch_app', 'focus_app', 'run_in_terminal', 'set_provider', 'set_model', 'set_voice', 'change_shortcut', 'pause_cadabra',
]);

export function summarize(r: LiveReport) {
  const done = r.tasks.filter((t) => t.status !== 'skipped');
  const med = (xs: number[]) => {
    if (!xs.length) return undefined;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };
  return {
    passed: done.filter((t) => t.status === 'pass').length,
    total: done.length,
    confirms: done.reduce((n, t) => n + t.confirms, 0),
    medianFirstTextMs: med(done.map((t) => t.firstTextMs).filter((x): x is number => x != null)),
    medianFirstToolMs: med(done.map((t) => t.firstToolMs).filter((x): x is number => x != null)),
    medianDoneMs: med(done.map((t) => t.doneMs).filter((x): x is number => x != null)),
    foreignTools: [...new Set(done.flatMap((t) => t.foreignTools))],
  };
}

export function toMarkdown(r: LiveReport): string {
  const lines = [`# Cadabra live-readiness: ${r.provider}`, '', `Started ${r.startedAt}.`];
  if (r.status === 'skipped') {
    lines.push('', `**Skipped:** ${r.skipReason ?? 'no backend available'}`);
    return lines.join('\n') + '\n';
  }
  const s = summarize(r);
  lines.push(
    '',
    `- Auth: ${r.auth ?? 'n/a'}`,
    `- Isolation: ${r.isolation ?? 'n/a'}`,
    `- Passed: **${s.passed}/${s.total}**, confirm cards: ${s.confirms}`,
    `- Median latency: first text ${s.medianFirstTextMs ?? '–'} ms, first tool ${s.medianFirstToolMs ?? '–'} ms, done ${s.medianDoneMs ?? '–'} ms`,
    `- Non-Cadabra tools used: ${s.foreignTools.length ? `**${s.foreignTools.join(', ')}** (isolation failure)` : 'none'}`,
    '',
    '| Task | Status | First text | First tool | Done | Tools | Confirms | Note |',
    '|---|---|---|---|---|---|---|---|',
  );
  for (const t of r.tasks) {
    lines.push(`| ${t.id}: ${t.prompt.replace(/\|/g, '/')} | ${t.status} | ${t.firstTextMs ?? '–'} | ${t.firstToolMs ?? '–'} | ${t.doneMs ?? '–'} | ${t.tools.join(', ') || '–'} | ${t.confirms} | ${(t.note ?? '').replace(/\|/g, '/')} |`);
  }
  return lines.join('\n') + '\n';
}
