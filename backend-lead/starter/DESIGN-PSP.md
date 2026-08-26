# DESIGN-PSP.md - adding the 50th PSP

## The problem today

`src/routes/pspCallbacks.ts` only understands one shape: `{ pspRef, status, amount }`. Adding a second PSP means either adding if/else branches to that one file, or copy-pasting it. Either way, every new PSP risks breaking every other one - including the exactly-once-credit logic that A2 spent real effort getting right. That's the opposite of "safe one-day task for a junior engineer."

The fix: keep everything PSP-specific (how to check the signature, what the fields are called, what the status words mean, what units the amount is in) in one small place per PSP, and never touch the core wallet code again.

## The interface

```ts
// src/psp/adapter.ts
interface PspAdapter {
  readonly id: string; // 'stripe', 'xendit', ... - matches the route and config

  // Checks the signature on the raw request. Throws if it's not valid.
  // Nothing past this point is trusted until this passes.
  verify(req: { headers: Record<string, string>; rawBody: Buffer }): void;

  // Turns the provider's own payload into our one shared shape.
  // This is the only place unit conversion, status words, and field
  // names for that PSP are handled.
  normalize(rawBody: Buffer): NormalizedCallback;
}

interface NormalizedCallback {
  pspRef: string;
  status: 'completed' | 'failed';
  amount: string; // already converted to normal decimal, not cents
}
```

`verify` and `normalize` are two separate steps on purpose. Verify is just a security check - reject bad requests before doing any work. Normalize is just data mapping - no side effects, easy to test with sample payloads.

## How it connects

```
POST /psp/:providerId/callbacks
        │
        ▼
look up adapter by providerId   ──▶  404 if we don't know this PSP
        │
        ▼
adapter.verify(req)             ──▶  401 if the signature is bad
        │
        ▼
adapter.normalize(req.rawBody)  ──▶  one shared shape
        │
        ▼
depositService.handlePspCallback(...)   ← same code as today, untouched
```

```ts
// src/routes/pspCallbacks.ts
router.post('/:providerId/callbacks', rawBodyParser, async (req, res, next) => {
  try {
    const adapter = adapterRegistry.get(req.params.providerId); // 404 if missing
    adapter.verify({ headers: req.headers, rawBody: req.rawBody });
    const normalized = adapter.normalize(req.rawBody);
    const result = await depositService.handlePspCallback(normalized.pspRef, normalized.status, normalized.amount);
    // ...same response as today
  } catch (err) {
    next(err);
  }
});
```

`handlePspCallback` - the row-locking, idempotent code from A2 - doesn't change. That's the whole point: the hard, correctness-critical part gets written once, and adding PSPs never touches it again.

## Adding a PSP is just config

```ts
// src/psp/registry.ts
const adapters: PspAdapter[] = [
  new StripeAdapter(config.psp.stripe),
  new XenditAdapter(config.psp.xendit),
  new MockPspAdapter(config.psp.mock),
];
export const adapterRegistry = new Map(adapters.map((a) => [a.id, a]));
```

To add PSP #50: write one new file implementing the interface, add one line to this list, add its secret to `.env`. No changes to routes, services, or the database.

## Testing without calling a real PSP

Each adapter comes with a small set of saved sample payloads: one `completed`, one `failed`, one with a bad signature, one badly formatted. A shared test file runs every adapter against its own samples and checks the same things for all of them:

- a correctly signed `completed` payload turns into `{ status: 'completed', amount: <decimal string>, pspRef: <string> }`
- a bad signature is rejected before `normalize` ever runs
- amounts in cents (or whatever units that PSP uses) come out converted correctly

This is what actually makes "one day, junior engineer, safely" true: build the adapter, drop in sample payloads recorded from the provider's docs or sandbox, run the shared tests. No real network call needed in CI, ever. The existing mock-PSP tests from A2 just become the first adapter's sample set under this same pattern.

## What this doesn't fix

- If a webhook never arrives at all (dropped, PSP down, no retry), the transaction stays stuck `pending` forever. This design doesn't add a way to poll for missed updates - that's separate, bigger work.
- Some PSPs need you to call *them* to check status, not just wait for a webhook. That would need one more method on the interface (`poll(pspRef)`), which I'm not designing here since nothing today needs it.
