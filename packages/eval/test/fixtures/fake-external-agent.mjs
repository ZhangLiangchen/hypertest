// A fake EXTERNAL agent (stands in for Claude Code / Codex / OpenHands invoked as a command) for the external-agent arm
// tests: node fake-external-agent.mjs <mode> <sutUrl> <report>. Modes: `probe` really exercises the bank API (a negative
// transfer) and reports what it saw; `green` reports pass without testing anything; `garbage` writes an invalid report;
// `crash` exits 3 without a report.
import { writeFileSync } from 'node:fs';

const [mode, sutUrl, report] = process.argv.slice(2);
if (mode === 'crash') process.exit(3);
if (mode === 'garbage') {
  writeFileSync(report, '{"verdict": "great"}');
  process.exit(0);
}
if (mode === 'green') {
  writeFileSync(report, JSON.stringify({ verdict: 'pass', findings: [], summary: 'looks fine' }));
  process.exit(0);
}
const post = async (path, body) => {
  const res = await fetch(`${sutUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};
const a = await post('/accounts', { owner: 'ext-a', balance: 10 });
const b = await post('/accounts', { owner: 'ext-b', balance: 10 });
const t = await post('/transfers', { from: a.json.id, to: b.json.id, amount: -5 });
const findings = t.status === 201
  ? [{ title: 'POST /transfers accepts a negative amount', description: `a transfer of amount -5 was answered ${t.status}: money moved backwards`, component: 'POST /transfers', severity: 'P1', reproduction: `POST ${sutUrl}/transfers {"amount":-5}` }]
  : [];
writeFileSync(report, JSON.stringify({ verdict: findings.length > 0 ? 'fail' : 'pass', findings, summary: `negative transfer answered ${t.status}` }));
