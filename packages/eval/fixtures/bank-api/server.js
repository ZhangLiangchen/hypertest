// bank-api — PoC B system under test (node:http, no dependencies).
//
//   POST /accounts            {owner, balance}         → 201 {id, owner, balance}
//   GET  /accounts/:id                                 → 200 account | 404
//   POST /transfers           {from, to, amount}       → 201 {transferId, from, to, amount}
//   GET  /health                                       → 200 {status, accounts, total, deposited, balanceConserved}
//   GET  /metrics                                      → Prometheus text (request counter, total balance gauge)
//   GET  /__eval/effects                               → {effects: {<Idempotency-Key>: count}} (ground truth for the eval probe)
//
// Hidden defect: the transfer validation rejects only a ZERO amount, so a negative amount is accepted (201) and moves
// money backwards (the recipient pays the sender). Money is still conserved: the defect is invisible to the total.
//
// Listens on 127.0.0.1:$PORT (0 = ephemeral) and prints one JSON line {"port": N} on stdout once it listens.
import http from 'node:http';

const accounts = new Map();
let nextAccount = 1;
let nextTransfer = 1;
let deposited = 0;
/** Mutating requests observed per idempotency key (never deduplicated: a duplicate call is visible here). */
const effects = new Map();
/** method path-template status → count */
const requests = new Map();

function send(res, status, body, route, method) {
  const key = `${method} ${route} ${status}`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; version=0.0.4' : 'application/json' });
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve(null);
      }
    });
  });
}

function total() {
  let sum = 0;
  for (const a of accounts.values()) sum += a.balance;
  return sum;
}

function metrics() {
  const lines = ['# HELP bank_requests_total Requests served.', '# TYPE bank_requests_total counter'];
  for (const [key, n] of [...requests].sort()) {
    const [method, route, status] = key.split(' ');
    lines.push(`bank_requests_total{method="${method}",route="${route}",status="${status}"} ${n}`);
  }
  lines.push('# HELP bank_total_balance Sum of all account balances.', '# TYPE bank_total_balance gauge', `bank_total_balance ${total()}`);
  lines.push('# HELP bank_deposited_total Sum of all opening balances.', '# TYPE bank_deposited_total gauge', `bank_deposited_total ${deposited}`);
  return `${lines.join('\n')}\n`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    const key = req.headers['idempotency-key'];
    if (typeof key === 'string' && key !== '') effects.set(key, (effects.get(key) ?? 0) + 1);
  }
  try {
    if (method === 'GET' && path === '/health') {
      const t = total();
      return send(res, 200, { status: 'ok', accounts: accounts.size, total: t, deposited, balanceConserved: t === deposited }, '/health', method);
    }
    if (method === 'GET' && path === '/metrics') return send(res, 200, metrics(), '/metrics', method);
    if (method === 'GET' && path === '/__eval/effects') return send(res, 200, { effects: Object.fromEntries(effects) }, '/__eval/effects', method);
    if (method === 'POST' && path === '/accounts') {
      const body = await readJson(req);
      if (!body || typeof body.owner !== 'string' || body.owner === '' || !Number.isInteger(body.balance) || body.balance < 0) {
        return send(res, 400, { error: 'invalid_account', message: 'owner (string) and balance (integer >= 0) are required' }, '/accounts', method);
      }
      const account = { id: `acc-${nextAccount++}`, owner: body.owner, balance: body.balance };
      accounts.set(account.id, account);
      deposited += body.balance;
      return send(res, 201, account, '/accounts', method);
    }
    const m = /^\/accounts\/([A-Za-z0-9-]+)$/.exec(path);
    if (method === 'GET' && m) {
      const account = accounts.get(m[1]);
      return account ? send(res, 200, account, '/accounts/:id', method) : send(res, 404, { error: 'not_found' }, '/accounts/:id', method);
    }
    if (method === 'POST' && path === '/transfers') {
      const body = await readJson(req);
      if (!body || typeof body.from !== 'string' || typeof body.to !== 'string' || typeof body.amount !== 'number' || !Number.isFinite(body.amount)) {
        return send(res, 400, { error: 'invalid_transfer', message: 'from, to (account ids) and amount (number) are required' }, '/transfers', method);
      }
      const from = accounts.get(body.from);
      const to = accounts.get(body.to);
      if (!from || !to) return send(res, 404, { error: 'unknown_account' }, '/transfers', method);
      if (from === to) return send(res, 400, { error: 'same_account' }, '/transfers', method);
      // DEFECT: only zero is rejected; a negative amount passes validation.
      if (body.amount === 0) return send(res, 400, { error: 'invalid_amount', message: 'amount must be positive' }, '/transfers', method);
      if (from.balance < body.amount) return send(res, 409, { error: 'insufficient_funds' }, '/transfers', method);
      from.balance -= body.amount;
      to.balance += body.amount;
      return send(res, 201, { transferId: `tx-${nextTransfer++}`, from: from.id, to: to.id, amount: body.amount }, '/transfers', method);
    }
    return send(res, 404, { error: 'no_route', path }, 'unknown', method);
  } catch (e) {
    return send(res, 500, { error: 'internal', message: String(e && e.message) }, path, method);
  }
});

server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => process.exit(0)));
