# DECISIONS.md

## How I use AI

I used Claude to write most of the code and a first draft of every decision below. 

I directed it step by step: schema, then A1/A2, then tests, then A3/A4, then tests, then these two docs. I checked every step myself - ran `tsc`, ran the tests against a real Postgres DB, wrote small scripts to check behavior by hand, and read the diffs. The architecture and trade-off calls (locking strategy, the two-table split, signed vs unsigned amounts, STRING+CHECK over ENUM, crediting the original deposit amount instead of the callback's) were AI-proposed; 

I reviewed each one, understood the reasoning, and can defend all of it - that's different from having made every call myself from a blank page, and I want to be upfront about that distinction rather than overstate it.

Where I did make the calls myself:
- Switching from implementation-first to test-first partway through (A1-A4 were built first, tests after; everything since has been tests first), 
- Deciding to leave A1-A4 as already built rather than redo them test-first for the sake of it, the writing style of these two docs (plain words, no AI-sounding prose), 
- Trimming several tests that turned out to be redundant with ones already in the suite (a couple of concurrency-burst tests that proved the same thing as a smaller test right next to them, just louder, and one withdrawal test whose assertions were a subset of another test's).

## Schema

There are three tables: `wallets` (already existed), `transactions`, `wallet_txs`

**Why two separate tables for `transactions` and `wallet_txs`:**
A `transaction` is money crossing the PSP boundary - it has a state (pending => completed/failed). A `wallet_tx` (ledger row) is just "the balance changed." A wager changes the balance but never touches a PSP, so it only makes a `wallet_txs` row, with `transaction_id = NULL`. Putting both in one table would mean wager rows carry a status field that means nothing for them.

**Why `STRING` + `CHECK` instead of Postgres `ENUM`:**
Enums are a bit smaller on disk. But adding a new value to an enum later is a real migration hassle. A `CHECK` constraint is just one line to change. Since this system is going to add more PSPs and probably more transaction types, I picked the one that's cheaper to change later.

**Why a partial unique index on `psp_ref`:**
This is what stops duplicate PSP callbacks from double-crediting (more below). It's partial (`WHERE psp_ref IS NOT NULL`) because withdrawals don't have a PSP ref yet when they're created.

**Why `wallet_txs` has no `updated_at`:**
The ledger must be append-only - never updated, never deleted. I can't fully enforce that at the database level without adding triggers or locking down permissions, which felt like too much for this exercise. Leaving out `updated_at` is a small signal in the schema that these rows shouldn't change.

**Signed vs unsigned amounts - different in each table, on purpose:**
- `transactions.amount` is always positive. The `type` column already says deposit or withdrawal. Making it signed too would just be a second place to get the sign wrong.
- `wallet_txs.amount` is signed (+ for credit, - for debit). This is the one place it should be, because the whole point of the ledger is: balance = sum of all its amounts. Signed amounts make that a plain `SUM`, no special-casing by type. `balance_after` is stored too, as a quick snapshot for reads, but the real source of truth is the sum.

All money is `DECIMAL(36,18)`, matching what the starter already used. All money math goes through `bignumber.js`. No JS `number` ever touches money.

## Locking

I used row locks (`SELECT ... FOR UPDATE`, `lock: t.LOCK.UPDATE` in Sequelize), not optimistic locking (version numbers + retry).

Why: the thing being locked (one wallet) is small, and the work done while holding the lock is short. Optimistic locking would mean writing retry logic on every money-moving endpoint, which is more code and more ways to get it wrong - especially given this exercise is specifically testing concurrent requests. A lock makes the correctness easy to see: as long as every place that reads-then-writes a balance takes the lock first, two requests simply can't race each other.

How it's used: `handlePspCallback` locks the `Transaction` row by `pspRef` first, then locks the `Wallet` row before crediting it. `recordWager` and `createWithdrawal` lock the `Wallet` row before touching the balance. All of this happens inside one DB transaction, so a second request has to wait for the first to finish before it can even read the balance.

One tradeoff: a slow PSP callback holds the wallet lock the whole time it runs. Fine at this size. Could become a real bottleneck with a slow PSP and high volume - worth watching in production.

## PSP callback idempotency (A2)

The requirement: the same callback, sent more than once, or sent at the same time twice, should only ever credit once. Here's how:

1. Lock the `Transaction` row by `pspRef`. Two callbacks arriving at the same time now line up one after the other instead of racing.
2. If the transaction is already `completed` or `failed`, do nothing - just return the current state. This handles both "sent twice in a row" and "sent twice at once" with the same check.
3. A transaction can only move `pending => completed` or `pending => failed`, once. A late callback that tries to change an already-resolved transaction is ignored, not applied. Tested.

Unknown `pspRef` returns `404`. I thought about returning `200` to avoid confirming which refs are real, but `pspRef` is a random UUID (nobody can guess one), so there's no real risk there, and `404` is much easier to debug when a real integration breaks.

## What happens if the callback amount doesn't match

If the callback says a different amount than what was recorded when the deposit was created, I credit the **original amount**, not the callback's amount. I flag it (`amountMismatch: true` in the response, plus a log line with both numbers).

Why: the callback body comes from outside the system and I don't trust it for the money figure. If a broken or malicious PSP could just say "credit $999999," that's a real hole - there's a test that a callback claiming a different amount still only credits the original. The original amount is what the member actually asked to deposit and what we already showed them. A real mismatch should go to a human to check, not get resolved automatically either way.

## Turnover lock (A4)

`requiredTurnover` = sum of (deposit amount × turnoverMultiplier) over that member's **completed** deposits only. Pending or failed deposits don't count.

`accruedTurnover` = sum of all wager amounts on that wallet.

**I did not build turnover "spending."** The spec says: withdraw is allowed once accrued turnover ≥ required turnover. That's a comparison of running totals, not a balance that gets used up. I built exactly that. The catch: once a member crosses the line, they can make more than one withdrawal off the same turnover, as long as each one has enough wallet balance. That's probably not what a real anti-abuse system wants - but the spec didn't say to reset or consume turnover, and guessing at an unwritten rule for an anti-abuse feature felt more risky than doing exactly what was asked and writing this note.

I compute both sums in JS with BigNumber, after loading the rows, instead of a SQL `SUM()`. This keeps all money math in one place (`src/lib/money.ts`) instead of splitting it between JS and SQL. Downside: doesn't scale well if a member has thousands of deposits/wagers - noted below as something to revisit.

Balance is checked after the turnover check, as a separate `422` with its own message, so the client knows which problem to fix.

## Testing

Tests run against a real Postgres database, through the real Express app, using `supertest`. No mocking of the database or Sequelize. The whole point of this system is correctness under concurrency, and a mocked test can't prove a lock actually stops a race - only a real database can. The concurrent-callback, concurrent-wager, and concurrent-withdrawal tests use `Promise.all` against the live app for exactly this reason.

## What I'd do with more time

- **Idempotency keys on wager/withdrawal requests.** Right now a client retry could create two wagers or two withdrawals by accident. PSP callbacks are safe because `pspRef` already works as an idempotency key - these endpoints have nothing like that. I'd add a client-supplied idempotency key header.
- **Decide the real turnover rule** - does it reset per deposit, get consumed on withdrawal, or something else? Needs a product decision, not a guess.
- **Enforce append-only at the database level** - a trigger, or a DB role with no UPDATE/DELETE rights on `wallet_txs`, so it's not just an application convention.
- **Real PSP authentication** - the mock callback trusts anyone who knows the `pspRef`. A real integration needs signature checking per provider before any of this logic runs. See `DESIGN-PSP.md`.
- **Turnover math at scale** - move from "load every row and sum" to a running-total column or an indexed query once volume is high.
- **Rate limiting** on the callback and money endpoints - out of scope here but a real gap.
- **Withdrawal approval** - stops at "pending, waiting on a human," as asked.

## What I didn't build, on purpose

- No queue for PSP callbacks. One DB transaction with row locks is enough at this size; a queue adds complexity for a problem that doesn't exist yet.
- No repository/DAO layer over Sequelize. Models plus a thin service layer is enough.
- No general PSP adapter code in Part A. There's one PSP right now. Building the real abstraction with only one example to design against would probably guess wrong - that's what `DESIGN-PSP.md` is for
