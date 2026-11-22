# api-hg — invocation guide

How to call the payments service: deposits through a hosted checkout page and
withdrawals to a bank account (CBU/CVU). Self-contained: nothing here refers
to internal source paths or to the provider behind it.

Two runtimes, one contract:

* **Lambda** — function `${ENV_NAME}-hg-<slug>`, direct `lambda:Invoke`
  with `{ headers, path, query, body }`; the response is the envelope below.
* **HTTP** — the same handlers behind one Node service (Kubernetes). The
  envelope is unwrapped: `data` is the body on success, and a failure is
  `{ errorCode, message, description, detail?, statusCode }` with the HTTP
  status set.

Identity is **only** the caller's platform JWT (`headers.authorization =
"Bearer <jwt>"`). The audience comes from the token's `metadata.partyType`:
`person`/`P` is a player, anything else an operator. Players act on their own
party and wallet account; operators see parties inside their own chain
subtree. The one endpoint without a JWT is the provider webhook, verified by
HMAC.

## Security, on every call

1. **JWT.** `Authorization: Bearer <jwt>` signed with the platform secret. Party,
   chain and `partyType` (player / operator) come from the token only; nothing
   in the request names the caller. 401 `AUTH_ERROR` otherwise.
2. **Session.** The `Session` row the token names (`sessionId` claim) must be
   `active` and unexpired in api-auth. 401 `AUTH_ERROR` when it was ended;
   500 `PERMISSIONS_UNAVAILABLE` when the check cannot be made (fails closed).
3. **Audience.** Player routes take player tokens, admin routes operator tokens.
   403 `FORBIDDEN`.
4. **Feature** (operator routes that change something: approve, reject, cancel,
   settings update, reconcile, player limits and blocks). An ACTIVE Feature of
   one of the caller's ACTIVE roles must ALLOW `(api-hg, <resource>, <method>)`
   with the route's resource and method as listed above. 403 `FORBIDDEN`.
5. **Chain.** Operators see and decide only payments of players under their own
   chain; a payment outside it is a 404.
6. **Account.** Player requests name the `accountId`; it must be one of the
   token's party's accounts (403 `FORBIDDEN`). The party is the security
   boundary, the account is what the payment is made on and listed by.
7. **Wallet.** Every wallet call made for a caller forwards the caller's JWT,
   so the wallet enforces the caller's own permissions. Only the provider
   webhook, which has no caller, uses the service's `x-api-key`.

## Envelope (Lambda)

```jsonc
{ "ok": true, "data": { /* endpoint-specific */ } }
{ "ok": false, "statusCode": 422, "error": { "type": "LIMIT_EXCEEDED", "message": "...", "description": "...", "detail": null } }
```

`error.type` values: `VALIDATION_ERROR` (400), `AUTH_ERROR` (401), `FORBIDDEN`
(403), `ENTITY_NOT_FOUND` (404), `CONFLICT` (409), `INVALID_STATE` (422),
`LIMIT_EXCEEDED` (422, generic: the player is never told which limit),
`REQUEST_IN_PROGRESS` (422, `detail` names the blocking withdrawal), `BLOCKED`
(403, an operator blocked this kind for the player; tell them to contact
support), `INSUFFICIENT_FUNDS` (422), `UPSTREAM_ERROR` (502),
`NOT_CONFIGURED` (503), `PAYMENTS_ERROR` (500). A 5xx message is always the
generic "There was an error processing the request".

## Functions

| slug | resource | method | audience |
|---|---|---|---|
| `deposits-create` | `/api/v1/payments/deposits` | POST | player |
| `withdrawals-create` | `/api/v1/payments/withdrawals` | POST | player |
| `withdrawals-cancel` | `/api/v1/payments/withdrawals/{id}/cancel` | POST | player |
| `payments-list` | `/api/v1/payments` | GET | player |
| `payments-get` | `/api/v1/payments/{id}` | GET | player |
| `admin-payments-list` | `/api/v1/payments/admin/payments` | GET | operator |
| `admin-payments-get` | `/api/v1/payments/admin/payments/{id}` | GET | operator |
| `admin-payments-approve` | `/api/v1/payments/admin/payments/{id}/approve` | POST | operator |
| `admin-payments-reject` | `/api/v1/payments/admin/payments/{id}/reject` | POST | operator |
| `admin-settings-get` | `/api/v1/payments/admin/settings` | GET | operator |
| `admin-settings-update` | `/api/v1/payments/admin/settings` | PUT | operator (root only) |
| `admin-payments-cancel` | `/api/v1/payments/admin/payments/{id}/cancel` | POST | operator |
| `admin-reconcile` | `/api/v1/payments/admin/reconcile` | POST | operator |
| `admin-payments-resolve` | `/api/v1/payments/admin/payments/{id}/resolve` | POST | operator |
| `admin-queue-list` | `/api/v1/payments/admin/withdrawals/queue` | GET | operator |
| `admin-queue-run` | `/api/v1/payments/admin/withdrawals/queue/run` | POST | operator |
| `admin-payments-prioritize` | `/api/v1/payments/admin/payments/{id}/priority` | PUT | operator |
| `admin-player-get` | `/api/v1/payments/admin/players/{partyId}` | GET | operator |
| `admin-player-limits-update` | `/api/v1/payments/admin/players/{partyId}/limits` | PUT | operator |
| `admin-player-block` | `/api/v1/payments/admin/players/{partyId}/blocks` | POST | operator |
| `admin-player-unblock` | `/api/v1/payments/admin/players/{partyId}/blocks/{blockId}/lift` | POST | operator |
| `webhook` | `/api/v1/payments/webhook` | POST | provider (HMAC) |

Working payloads are in `tests/events/`.

## The payment object

Every endpoint returns or lists `Payment` objects. Amounts are **major units**
(`1500.50`), in the account's currency.

```jsonc
{
  "id": "3f0c0a2e-...",            // uuid, the only id a caller ever needs
  "kind": "deposit",               // "deposit" | "withdrawal"
  "status": "pending",             // see the two lifecycles below
  "amount": 1500.5,
  "currency": "ARS",
  "fee": null,                     // provider fee once known (withdrawals), else null
  "createdAt": "2026-11-16T10:00:00.000Z",
  "updatedAt": "2026-11-16T10:00:00.000Z",
  "completedAt": null,
  "hold": false,                   // true when it is (or was) waiting for an operator
  "checkoutUrl": "https://...",    // deposits while "pending", else null
  "expiresAt": "2026-11-17T10:00:00.000Z", // deposits, else null
  "destination": { "type": "cvu", "value": "0000003100012345678901", "holderName": "A. Perez" }, // withdrawals, else null
  "note": null                     // operator's reason, present on "rejected"
}
```

To a **player** `destination.value` is masked (`•••• 8901`). To an **operator**
the object also carries: `partyId`, `username`, `chain`, `accountId`,
`provider` (which integration handled it, e.g. `hg`), `walletOperationId`,
`walletStatus`, `providerRef`, `providerStatus`, `providerData` (the
provider's raw response, verbatim), `payer` (deposits: `{ name, email }` — the
national id is **not** stored), `documentHash` (keyed HMAC-SHA256 of the
national id the player gave, for comparing later entries without holding the
number), `client` (`{ ip, userAgent }` of the request, from the
`x-player-ip` / `x-player-user-agent` headers the front-end forwards),
`decidedBy`, `decidedByName`, `decidedAt`, `errorCode`, `priority` (withdrawals: place in
the queue, lower first; null outside it). An operator sees the status
`queued`; a player sees that same withdrawal as `processing`.

### Deposit lifecycle

```
pending ──(payer pays)──▶ awaiting_approval ──approve──▶ completed
   │                            │                            ▲
   │                            └──reject──▶ rejected        │
   ├──(hold off)───────────────────────────────────────────────┘
   ├──▶ under_review   (provider asks a human to check the receipt; then completed/rejected)
   ├──▶ expired        (checkout not paid in time)
   └──▶ cancelled      (checkout cancelled)
```

Money reaches the wallet balance **only** at `completed`. Nothing is created
in the wallet before that: the wallet deposit operation is created and
completed in one step once the provider confirms the payment, so a pending,
expired or cancelled deposit leaves no trace in the wallet. With `holdDeposits` off (and the amount under
`holdDepositsAbove`, when set) a paid deposit goes straight to `completed`.

### Withdrawal lifecycle

```
awaiting_approval ──approve──▶ queued ──(queue run, account covers it)──▶ processing ──(transfer done)──▶ completed
   │                             │  ▲                                        ├──(provider error)──▶ failed  (money released)
   │                             │  └──(provider still short of funds: back in the queue, same place)
   │  ┌──(hold off: created directly as queued)
   │  │                          └──reject──▶ rejected  (money released)
   ├──reject──▶ rejected   (money released)
   └──cancel──▶ cancelled  (player, only while awaiting_approval; money released)
```

The amount is **blocked in the wallet the moment the request is accepted**
(a pending withdrawal operation), so it cannot be bet or withdrawn twice.
`completed` finalises the wallet operation; `rejected`, `failed` and
`cancelled` cancel it and the blocked amount returns to the balance.

#### The withdrawal queue

Nothing is sent to the provider when a withdrawal is approved (or created
without a hold): it joins the tenant's queue as `queued`, with `priority` =
the current highest + 1000. **Every minute** a run reads the provider
account's balance (`withdrawalAccountId`, or the deployment's account) and
pays the queue in `priority` order (ties by creation time), following the
tenant's `withdrawalQueueMode`:

* `fifo_stop_on_fail` (default): send each one in order; stop at the first
  the balance does not cover. Nothing behind it is paid before it.
* `fit`: walk the whole queue; send every one the balance covers, skip the
  rest (like a bank clearing cheques).

Each transfer sent lowers the balance the run works with. When the provider
itself refuses one for funds (fees, a transfer made elsewhere), the withdrawal
goes back to `queued` at its own place with `errorCode: PROVIDER_FUNDS` and
the event `provider_funds_short`; it counts as "does not fit". An operator
can move a queued withdrawal (`admin-payments-prioritize`, any integer; the
gaps of 1000 are there to slot one between two others), run the queue now
(`admin-queue-run`), or reject it (`admin-payments-reject`, money released).
The player sees a queued withdrawal as `processing`.

#### Every failure has a way out

Each step is written so that stopping anywhere leaves a state that resolves
on its own on the next webhook, re-check or retry; nothing needs a manual
database fix.

* **Wallet refuses or does not answer** on any step: the row is not changed,
  the action returns `UPSTREAM_ERROR` and can be repeated. Wallet operations
  are created and moved with the payment id as their reference, so a repeat
  finds the existing operation instead of creating or moving a second one.
* **Provider refuses the transfer** (queue run): `failed`, blocked amount
  released, reason in the payment's `logs`. One refusal is different: when the
  **provider account is short of funds**, the withdrawal goes back to `queued`
  at its place with the money still blocked (event `provider_funds_short`,
  `errorCode: PROVIDER_FUNDS`); the next run with enough balance sends it.
  `withdrawalAccountId` in the settings picks the provider account per tenant.
* **Provider balance cannot be read** (queue run): nothing is sent that
  minute; the queue is untouched and the next run tries again.
* **Provider does not answer, or the answer is lost** (timeout, 5xx, crash
  after it accepted): the withdrawal stays `processing` **without a provider
  reference** and the money stays blocked; the event trail shows
  `submit_unknown`. The payment id is the provider's external id, unique per
  account, so the request is re-sent by the re-check (`payments-get`,
  `admin-reconcile`) and can never make a second transfer: it succeeds (the
  first never existed), is refused (`failed`, money released) or is reported
  as a duplicate (`submit_duplicate`: the first exists). Its reference then
  arrives with the provider's webhook, or an operator attaches it with
  `admin-payments-resolve`.
* **Webhook processing fails**: the provider's retry of the same delivery is
  processed again (only successfully processed deliveries are treated as
  duplicates), and the re-check covers a delivery that never comes back.
* **Transfer done at the provider but the wallet step failed**: the next
  webhook or re-check applies the final status again; completing or
  cancelling an operation that already is completed or cancelled counts as
  done.

## Player endpoints

### `deposits-create` — POST `/api/v1/payments/deposits`

```jsonc
{ "amount": 1500.5,
  "accountId": "123",                   // required: the wallet account the deposit lands on; must belong to the caller (403 otherwise)
  "payer": { "document": "30123456", "name": "Ana Perez", "email": "ana@example.com" } } // optional; document required for some countries
```

Returns the `Payment` (`pending`) with `checkoutUrl`. Send the player there.
422 `LIMIT_EXCEEDED` outside the player's effective limits
(per request or rolling caps; generic message), 403 `BLOCKED` when an operator
blocked deposits for the player, 503 `NOT_CONFIGURED` when deposits are
disabled. `payer.document` is forwarded to the provider and kept only as
`documentHash`.

#### Coming back from the payment page (player UI)

The payment page sends the player back to two URLs that the operator sets per
environment (`payments-return-url` and `payments-cancel-url`). The service
appends the payment id:

| When | Where the player lands |
|---|---|
| Payment finished on the page | `<return url>?payment=<id>` |
| Player left / cancelled the page | `<cancel url>?payment=<id>&cancelled=1` |

The UI behind both URLs should read `payment`, call `payments-get` and show
the status it returns, polling while it is not final. Landing on the return
URL is not proof of payment: the status changes only when the provider
confirms it (webhook, or the re-check that `payments-get` runs on a pending
deposit). What each status means for the player:

| `status` | Show |
|---|---|
| `pending` | not paid yet; `checkoutUrl` is still valid, offer "continue payment" |
| `awaiting_approval`, `under_review` | paid, being reviewed, will be credited |
| `completed` | credited to the balance |
| `rejected`, `failed` | could not be completed |
| `expired`, `cancelled` | no longer available, offer a new deposit |

The `cancelled=1` flag only says the player came from the cancel link; the
payment itself may still be `pending` (the page can be reopened) until it
expires or is cancelled.

### `withdrawals-create` — POST `/api/v1/payments/withdrawals`

```jsonc
{ "amount": 2000,
  "accountId": "123",                   // required: the wallet account the money leaves; must belong to the caller (403 otherwise)
  "destination": { "type": "cbu", "value": "0170099220000067797370", "holderName": "Ana Perez" } }
```

`type` is `cbu` or `cvu`; `value` is 22 digits; `document` (optional national
id) is hashed, never stored. Returns the `Payment` (`awaiting_approval`, or
`processing` when no hold applies: it is queued and paid by the next queue
run). 422 `INSUFFICIENT_FUNDS` when the wallet has not enough
withdrawable (payout) balance; 422 `LIMIT_EXCEEDED` when the amount is outside
the player's effective limits (per request or rolling day/week/month caps — the
message never says which); 422 `REQUEST_IN_PROGRESS` when the player already
has `maxOpenWithdrawals` open (`detail` = the blocking one); 403 `BLOCKED` when
an operator blocked withdrawals for the player.

### `withdrawals-cancel` — POST `/api/v1/payments/withdrawals/{id}/cancel`

Only while `awaiting_approval`; otherwise 422 `INVALID_STATE`. Returns the
`Payment` (`cancelled`).

### `payments-list` — GET `/api/v1/payments`

Query: `kind` (`deposit` | `withdrawal`), `status` (comma list), `limit`
(default 20, max 100), `cursor` (from the previous page).

```jsonc
{ "data": [ Payment, ... ], "nextCursor": "eyJ..." | null }
```

### `payments-get` — GET `/api/v1/payments/{id}`

The player's own payment, 404 otherwise. A `pending` deposit older than a
minute is re-checked with the provider on read, so a missed webhook still
resolves when the player looks.

## Operator endpoints

All rows are scoped to the caller's chain subtree; a payment of a party
outside it is a 404.

### `admin-payments-list` — GET `/api/v1/payments/admin/payments`

Query: `kind`, `status` (comma list; `open` expands to every non-final
status, `all` means no filter), `accountId` (the wallet account, the id to track payments by), `partyId`, `from`, `to` (ISO dates, on `createdAt`), `limit`
(default 50, max 200), `cursor`. Response as `payments-list`, with the
operator fields.

### `admin-payments-get` — GET `/api/v1/payments/admin/payments/{id}`

```jsonc
{ "payment": Payment,
  "events": [ { "at": "...", "actor": "player" | "operator:<partyId>" | "provider" | "system", "actorName": "Ana Perez" | null, "type": "created", "data": {} } ],
  "logs":   [ { "id": "41", "at": "...", "kind": "request" | "webhook", "method": "POST" | null, "path": "/checkouts" | null,
                "status": 400, "ms": 664, "request": {}, "response": {}, "error": "HTTP 400" | null } ] }
```

`actorName` is the display name of the player or operator behind the event;
show it, not the id.

`logs` is the exchange with the payment provider for this payment, newest
first, up to 100 rows: `request` rows are calls this service made (`method`,
`path`, the provider's HTTP `status`, `0` when unreachable); `webhook` rows are
deliveries the provider made for this payment (`status` is what the service
answered, `401` for a bad signature, `200` for accepted or duplicate).
`request` and `response` are the bodies as sent and received, with sensitive
values (credentials, national ids, emails, phones, bank account numbers)
replaced by `"[redacted]"`; show them as formatted JSON. `error` is set when
the exchange failed. Rows are for operators only; never surface them to a
player.

### `admin-payments-approve` — POST `.../{id}/approve` · `admin-payments-reject` — POST `.../{id}/reject`

Body `{ "note": "..." }` (optional on approve, required on reject, max 500).
Only `awaiting_approval` payments (reject also takes a `queued` withdrawal);
otherwise 422 `INVALID_STATE`; a decision that lost a race is 409 `CONFLICT`.
Approving a deposit credits the wallet; approving a withdrawal puts it in the
queue (`queued`, see the withdrawal lifecycle): the bank transfer is sent by
the queue run once the provider account covers it. Rejecting releases the
withdrawal's blocked amount; a rejected deposit never touches the wallet (the
money the payer sent stays with the operator to refund outside the platform;
the event trail records it). Returns the `Payment`.

### `admin-payments-cancel` — POST `.../{id}/cancel`

Body `{ "note" }` (required). Only a deposit still `pending` (nobody paid):
the provider's checkout is cancelled and the pending wallet deposit dropped.
Returns the `Payment` (`cancelled`).

### `admin-settings-get` — GET · `admin-settings-update` — PUT `/api/v1/payments/admin/settings`

Settings are per tenant (the root of the caller's chain). Any operator may
read; only a **root** operator (empty chain) may update, others get 403.

```jsonc
{
  "depositsEnabled": true,
  "withdrawalsEnabled": true,
  "holdDeposits": false,            // every paid deposit waits for approval
  "holdDepositsAbove": 100000,      // or only from this amount; null = never
  "holdWithdrawals": true,          // every withdrawal waits for approval
  "holdWithdrawalsAbove": null,
  "minDeposit": 1000, "maxDeposit": 2000000,
  "minWithdrawal": 1000, "maxWithdrawal": 1000000,
  "dailyDepositMax": null, "weeklyDepositMax": null, "monthlyDepositMax": null,       // rolling 24 h / 7 d / 30 d caps; null = none
  "dailyWithdrawalMax": null, "weeklyWithdrawalMax": null, "monthlyWithdrawalMax": null,
  "maxOpenWithdrawals": 1,
  "withdrawalAccountId": null,      // provider account the bank transfers are paid from; null = the deployment's account
  "depositAccountId": null,         // provider account deposits are opened on; null = not sent (the provider picks by country)
  "withdrawalQueueMode": "fifo_stop_on_fail", // or "fit"; see the withdrawal queue
  "currency": "ARS",                // read-only, from the deployment
  "updatedAt": "...", "updatedBy": "<partyId>" | null
}
```

PUT accepts any subset of the writable fields and returns the full object.

### Per-player limits and blocks

`GET /api/v1/payments/admin/players/{partyId}` (`admin-player-get`):

```jsonc
{
  "partyId": "...",
  "limits": { "minDeposit": null, "maxDeposit": null, "minWithdrawal": null, "maxWithdrawal": 50000,   // the player's overrides; null = tenant value
              "dailyDepositMax": null, "weeklyDepositMax": null, "monthlyDepositMax": null,
              "dailyWithdrawalMax": 100000, "weeklyWithdrawalMax": null, "monthlyWithdrawalMax": null,
              "maxOpenWithdrawals": null, "note": "VIP review pending", "updatedAt": "...", "updatedBy": "<partyId>" },
  "effective": { "deposit": { "min": 1000, "max": 2000000, "daily": null, "weekly": null, "monthly": null, "maxOpenWithdrawals": 1 },
                 "withdrawal": { "min": 1000, "max": 50000, "daily": 100000, "weekly": null, "monthly": null, "maxOpenWithdrawals": 1 } },
  "usage": { "deposit": { "day": 2000, "week": 2000, "month": 2000 }, "withdrawal": { "day": 0, "week": 0, "month": 0 } },
  "blocks": [ { "id": 1, "kind": "withdrawal", "until": "2026-11-18T..." | null, "reason": "...", "createdBy": "...", "createdAt": "...", "liftedAt": null, "liftedBy": null, "active": true } ],
  "blocked": { "deposit": false, "withdrawal": true }
}
```

`PUT .../players/{partyId}/limits` (`admin-player-limits-update`): any subset
of the `limits` fields; `null` removes an override. Returns the overview.

`POST .../players/{partyId}/blocks` (`admin-player-block`): `{ "kind":
"deposit" | "withdrawal" | "all", "reason", "days"?: 2 | "until"?: ISO }`;
neither `days` nor `until` = permanent. Returns the overview.

`POST .../players/{partyId}/blocks/{blockId}/lift` (`admin-player-unblock`):
lifts one block early. Returns the overview.

Usage windows are rolling (last 24 h / 7 d / 30 d) over every payment of the
kind that is or may become money moved (`pending`, `under_review`,
`awaiting_approval`, `processing`, `completed`). A player outside the
operator's subtree is a 404; a player with no payment yet can only be managed
by a root operator.

### `admin-reconcile` — POST `/api/v1/payments/admin/reconcile`

Re-checks with the provider every open payment of the caller's subtree that
has not changed for 10 minutes, and re-sends the transfer request of every
`processing` withdrawal that has no provider reference yet.
`{ "checked": 12, "updated": 3 }`.

### `admin-payments-resolve` — POST `.../{id}/resolve`

For a withdrawal that is `processing` **without a provider reference** (its
`Payment` has `providerRef: null`; the event trail shows `submit_unknown` or
`submit_duplicate`). Two bodies:

```jsonc
{ "providerRef": "<the provider's transaction id>", "note": "found by external id" }   // attach it; the transfer's state is then read and applied
{ "outcome": "failed", "note": "no transfer exists at the provider" }                  // close it; the blocked amount returns to the player
```

The operator finds the transfer at the provider by its external id, which is
the payment `id`. Returns the `Payment`. 422 `INVALID_STATE` for any other
payment or when a reference already exists (those resolve on their own).

### `admin-queue-list` — GET `/api/v1/payments/admin/withdrawals/queue`

The subtree's `queued` withdrawals in payment order (`priority`, then creation).

```jsonc
{ "mode": "fifo_stop_on_fail",
  "balance": 250000.5,     // provider account balance usable for transfers; root operators only, null when the provider did not answer
  "items": [ /* Payment objects, operator view, each with "priority" */ ] }
```

### `admin-queue-run` — POST `/api/v1/payments/admin/withdrawals/queue/run`

Pays the caller's tenant queue now (the same thing the minute run does).

```jsonc
{ "tenant": "root1", "mode": "fifo_stop_on_fail", "balance": 250000.5,
  "queued": 4, "submitted": 2, "skipped": 0,
  "stopped": true,          // fifo_stop_on_fail: stopped at one the balance did not cover
  "busy": false }           // true = another run of this tenant was in progress; nothing was done
```

`null` when the tenant has nothing queued.

### `admin-payments-prioritize` — PUT `/api/v1/payments/admin/payments/{id}/priority`

Body `{ "priority": 1500 }` (integer ≥ 0; lower is paid first). Only a
`queued` withdrawal, otherwise 422 `INVALID_STATE`. Returns the `Payment`.
Positions are assigned in steps of 1000, so to place one between 1000 and
2000 send 1500.

## Webhook — POST `/api/v1/payments/webhook`

Called by the provider, not by the front-ends. Raw body + the provider's
signature header; unsigned or badly signed calls are 401. Idempotent: a
delivery already processed answers 200 without side effects. Every delivery,
accepted or refused, appears masked in the payment's `logs`
(`admin-payments-get`) when it names a known payment.
