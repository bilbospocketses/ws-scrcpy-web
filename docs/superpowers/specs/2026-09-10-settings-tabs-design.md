# Settings Panel — Tabs, Staged Saves, and a Durable Change Log

**Item:** 127
**Date:** 2026-09-10
**Status:** design approved, ready for an implementation plan
**Estimate:** 8–12 hours, most of it the `SettingsModal` split

## 1. Goal

Turn the Settings dialog from one 2,262-line vertical scroll into tabs, let scalar settings accumulate
as staged edits, and confirm them through a change summary before anything is written. Move the
dependency panel off the home page into a tab, leaving an alert card behind.

## 2. Why this is not a UI change

The save model today is **mixed, and the mixing is the design problem**:

| Surface | Save behaviour today |
|---|---|
| Server → `webPort` | its own Save button → `PATCH /api/config` (`SettingsModal.ts:1226`) |
| Updates | saves on **every change** via `patchUpdatesConfig()` (`:1538`) — no button |
| Service / Users / Embedding / Reset | **actions**, not settings; several carry their own confirmations |

A summary screen that listed "install service" alongside "port: 8000 → 8001" would be lying about what
Save does. So the first job is drawing the line, and the second is making the line structural rather
than a rule someone has to remember.

### 2.1 Stageable vs. immediate

| Stageable — dirty-tracked, summarised, batch-saved | Immediate — act now, keep existing confirmations |
|---|---|
| `webPort` (Server) | install / uninstall service (fires UAC) |
| Updates: channel, auto-update, check interval | create / delete user |
| future scalar settings | reset prompts; add / remove embed origin |
| | dependency install / update / retry |

**Actions never appear in the summary.** Section 3 makes that structural.

## 3. Architecture

Three layers, each testable without the one above it.

### 3.1 `StagedSettingsStore` — no DOM, no network

```ts
register(field: { id: string; label: string; initial: unknown; format?(v: unknown): string }): void
set(id: string, value: unknown): void
isDirty(): boolean
changes(): Change[]        // { id, label, from, to }
reset(): void              // back to initial
clear(): void              // drop registrations (modal closed)
```

`changes()` is the single source for the summary, so the summary cannot disagree with what will be
applied.

### 3.2 `SaveRunner` — a thin client over one endpoint

Takes `Change[]`, POSTs them as one batch, renders the result. It does **not** own ordering, durability
or apply logic — the server does (§4). Kept as its own module rather than folded into the modal so the
store stays pure: *what changed* and *how to persist it* are different questions, and only the second
needs mocking.

**The apply engine is server-side.** `SaveRunner` calling `/api/config` and `/api/updates/config` itself
would put the ordering guarantee in browser JavaScript and spread the WAL transitions across separate
round trips — which makes §4.2 a race rather than a fact. One request keeps the whole sequence in one
process.

### 3.3 Tab modules — presentational

Each builds its DOM and registers its stageable fields. **Action-only tabs register nothing**, which is
what makes §2.1's rule impossible to violate: a tab with no registered fields cannot contribute to
`changes()`, so no future action can leak into the summary by oversight.

```
src/app/client/settings/
  SettingsModal.ts           shell: tab strip, mounts tabs, owns store, wires Save
  StagedSettingsStore.ts     dirty / diff / summary — no DOM, no network
  SaveRunner.ts              endpoint grouping, ordering, WAL, apply
  SettingsSummaryModal.ts    the change-summary confirm
  tabs/{Embedding,Users,Server,Updates,Service,Dependencies}Tab.ts
```

### 3.4 The constraint that shapes the shell

`fillBody` runs **before** the `/api/config` runtime probe resolves, deliberately. Blocking the body on
that second fetch means a hung `/api/config` renders a permanently **empty** dialog, and the modal's own
tests stub fetch as a never-resolving promise precisely to pin "the body still renders".

**The shell builds the tab strip and the active tab synchronously; `refresh()` populates afterwards.**
Item 81 hit this same wall and split it the same way: section *visibility* gates on `canSeeSection`
alone, while `canUse()` (which composes in `adminApiReachable`) gates only post-probe network calls.

## 4. The save pipeline

Staging is in-memory. Only the **commit** touches the DB, so the common path stays cheap.

### 4.0 The endpoint

```
POST /api/settings/batch
  body:     { changes: [{ id, label, from, to }] }
  response: { ok, applied: string[], failed?: { id, error }, restartRequired?, redirectPort? }
```

**Operator-gated** via `requireOperator` like every other admin route (item 81), and the acting
`user_id` comes from `resolveUserId(req)` — the same resolution every handler uses, which is what makes
the audit column meaningful once sign-in is on.

`restartRequired` / `redirectPort` are passed straight through from the `webPort` apply so the client
keeps its existing redirect behaviour unchanged.

The whole sequence below runs **inside this one handler**, in one process:

1. Write the batch to `pending_settings` as one row — `status='pending'`, changes as JSON, acting
   `user_id`, timestamp.
2. Apply every **non-restarting** change first, marking each as it lands.
3. Apply **`webPort` last, always**.
4. Mark `completed` — **before** the port PATCH when one is present.

Steps 2–4 reuse the existing config and updates write paths rather than duplicating validation; the
handler orders and records, it does not reimplement.

### 4.1 Why `webPort` is last

It is the only change that ends the process: `restartRequired` → `redirectPort` → exit 75 → the
supervisor restarts on the new port → the browser navigates itself there after 4 s
(`SettingsModal.ts:1240-1251`). Making it terminal means nothing can be stranded behind it.

### 4.2 Why `completed` is marked before that PATCH

After the port PATCH we may never get another instruction in. The two failure shapes are not symmetric:

- **Stale `completed`** (crash during the port PATCH): inert. Nothing re-applies.
- **Stale `pending`** (marking after): the restart *guarantees* we never mark it, so **every** port
  change would leave a row the next boot could re-apply.

An inert wrong record beats a record that re-applies settings the user already has.

### 4.3 Failure before `webPort`

Stop. Do not apply the port, do not restart. Row goes `status='failed'` with the failing change. The
modal stays open with changes intact, so retry or Cancel loses nothing.

### 4.4 On boot

A `pending` row means a previous instance died mid-batch. **Log it and mark `abandoned`. Never
auto-apply.** Silently applying settings a user may not remember confirming is worse than losing them,
and the durable record still explains what happened.

### 4.5 Why the DB, and not browser storage

**The new port is a different origin.** Port is part of the origin tuple, so after the redirect to
`host:newport`, `localStorage` / `sessionStorage` from the old origin is unreadable. Any design that
carries staged state across the restart in browser storage is broken on arrival.

The DB lives in the data root, survives both the restart and the origin change, and the new instance can
serve the pending set to the browser on its new origin. It also gives **one code path** whether or not a
port change is involved.

⚠️ **Audit caveat.** In open mode every request resolves to the implicit admin (`user_id = 1`), so the
"who changed what" value only becomes real once sign-in is enabled.

### 4.6 Mixed batches are allowed

An earlier draft forbade batches containing both `webPort` and other changes. **Superseded**: with
`webPort` last plus the WAL, nothing can be stranded, so forbidding would cost the user a second Save
and buy no safety.

## 5. Schema

One migration, `src/server/db/migrations/002_pending_settings.ts`, plus one entry in the `MIGRATIONS`
array. The framework already runs each migration in a transaction behind a `user_version` downgrade
guard.

```
id          INTEGER PRIMARY KEY
user_id     INTEGER
created_at  INTEGER
status      TEXT     -- pending | completed | failed | abandoned
changes     TEXT     -- JSON: [{ id, label, from, to }]
error       TEXT NULL
```

**Retention:** on boot, delete `completed` / `abandoned` rows older than 90 days. Bounded, and leaves a
usable window for the deferred history UI.

## 6. Dependencies re-home

1. `DependencyPanel` moves out of `index.ts:406` into a Settings tab, internally unchanged.
2. The home page keeps **only** an alert card, shown when dependencies need updating, linking to the tab.
3. The card reuses `FirstRunBanner`'s item-81 pattern: mount **inert** — no fetch, no interval — when
   `adminApiReachable()` is false.

Point 3 is not optional. `/api/dependencies` is admin-gated at the top of its handler, so an ungated card
in a flagless container 403-spams every interval and shows an error to a user whose app is healthy. That
is **finding 9.6** verbatim, and `'dependencies'` is already in `ADMIN_ONLY_SECTIONS`.

## 7. Behaviour changes users will notice

**Updates stops saving instantly.** Today every toggle fires `patchUpdatesConfig()`. After this, a user
who flips auto-update and closes without saving gets **no** change, where today they would have gotten
one. This is the correct model but it is a real break, and the existing tests assert the old one.

**Switching tabs never prompts.** Edits persist across tabs. Prompting between tabs of one dialog is
hostile and trains people to click through.

**Closing while dirty prompts Save / Discard / Cancel**, where Cancel returns with changes intact.

**`webPort` gets a plain-words restart warning in the summary.** A user who reads "Port: 8000 → 8001" and
expects nothing else will think the app crashed.

## 8. Error handling

| Failure | Behaviour |
|---|---|
| DB write fails before apply | Abort. Nothing applied. Modal open, changes intact. |
| A change fails mid-batch | Stop. `status='failed'` + which one. No port PATCH, no restart. |
| Boot finds a `pending` row | Log, mark `abandoned`. Never auto-apply. |
| `/api/config` probe hangs | Body still renders (§3.4). Post-probe calls are gated, not the DOM. |

## 9. Testing

1. **Store** (no DOM): dirty survives tab switch; `changes()` excludes every action; `reset()` restores.
2. **Batch handler** (server, no DOM): `webPort` ordered last; stop-on-first-failure leaves the port
   unapplied; WAL status transitions; `requireOperator` refuses an off-box caller.
3. **Migration**: `002` applies; the downgrade guard still fires.
4. **DOM**: summary renders from `changes()`; `ConfirmModal` reuse does not double-`showModal()` (the
   trap at `AdminConfirmModal.ts:25-41` — the base `Modal` constructor already appends and shows, and
   calling either again throws `InvalidStateError`, rejecting the promise and silently breaking the
   buttons while leaving the dialog visible); alert card respects both predicates.
5. **Regression**: the existing never-resolving-fetch test still proves the body renders.

Most of item 127's test list is store-level, which is the point of §3.1 — they need no DOM at all.

## 10. Out of scope

**A change-history UI** (what changed, when, by whom). The WAL makes the data exist; surfacing it is a
separate capability this item never asked for, and it is only meaningful once sign-in is on. File as its
own item when the app goes more mainstream (user's call, 2026-09-10).

**The ~470 lines of exported pure helpers** at the top of the current file move to their owning tab
modules. Mechanical, but it changes `SettingsModal.test.ts`'s imports — expect that churn in the diff
rather than discovering it.

## 11. Decisions taken during design

| # | Decision | Why |
|---|---|---|
| 1 | `webPort` applies **last** | only change that ends the process; makes stranding impossible |
| 2 | Pending changes in **SQLite**, not browser storage | the new port is a different origin (§4.5) |
| 3 | WAL covers **every** batch, not just restart-crossing ones | one code path; complete audit trail |
| 4 | **Store + presentational tabs** | makes "actions never appear in the summary" structural |
| 5 | Mark `completed` **before** the port PATCH | a stale `completed` is inert; a stale `pending` re-applies |
| 6 | Mixed batches **allowed** | 1 + 2 already prevent stranding |
| 7 | Apply **server-side**, one `POST /api/settings/batch` | keeps ordering and the WAL transitions in one process, so 5 is correct by construction rather than by careful client sequencing |
