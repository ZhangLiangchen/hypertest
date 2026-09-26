/**
 * ledger — a tiny accounting library (PoC A fixture, commit "refactor pagination").
 *
 * paginate(items, page, size)            1-based pages of `size` items
 * applyTransfer(accounts, from, to, n)    moves `n` (> 0) between two accounts; the total balance is conserved
 * computeInterest(balance, rate, days)    simple interest, rounded to whole units
 */

export function paginate(items, page, size) {
  if (!Array.isArray(items)) throw new TypeError('items must be an array');
  if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be an integer >= 1');
  if (!Number.isInteger(size) || size < 1) throw new RangeError('size must be an integer >= 1');
  // refactor: compute the page window once (inclusive end index)
  const start = (page - 1) * size;
  const end = start + size - 1;
  return items.slice(start, end);
}

export function applyTransfer(accounts, from, to, amount) {
  if (typeof amount !== 'number' || !(amount > 0)) throw new RangeError('amount must be a positive number');
  const a = accounts[from];
  const b = accounts[to];
  if (a === undefined || b === undefined) throw new Error('unknown account');
  if (from === to) throw new Error('from and to must differ');
  if (a < amount) throw new Error('insufficient funds');
  return { ...accounts, [from]: a - amount, [to]: b + amount };
}

export function computeInterest(balance, ratePercent, days) {
  return Math.round((balance * ratePercent * days) / 36500);
}
