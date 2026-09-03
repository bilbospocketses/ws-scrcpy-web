# Automation coverage register

Per-row automation status for `smoke-test.md`. **Seeded by P3 task 5; the full
127-row triage lands in task 16.** Until then this file holds only the container
findings task 5 was required to record rather than fix silently.

Companion to `smoke-test.md`, not a replacement: that document remains the
canonical list of rows and their steps.

---

## Module 20 — container (Docker) behaviour

New module. Modules run 1–19 with 17 a deliberate tombstone, so 20 is the next
free number.

### Gated in task 5 (SP4 E4)

| # | Affordance | Container behaviour | Status |
|---|---|---|---|
| 20.1 | Settings → Service | replaced by *"service install not applicable — this instance runs in a container."* | automated (`settingsModal.dockerGating.test.ts`; container smoke in task 11) |
| 20.2 | Settings → Updates | replaced by *"update via `docker pull bilbospocketses/ws-scrcpy-web:latest`."* | automated (same) |
| 20.3 | libfuse2 banner | **nothing to hide — the gate no longer exists** | n/a, see below |

**20.3 is satisfied by deletion, not by gating.** SP4 decision 4 requires the
libfuse2 banner hidden in Docker, but the libfuse2 first-run gate was removed
end-to-end in an earlier release — `isLibfuse2Installed` / `ensureLibfuse2`
(`SystemdClient.ts`), the `/api/updates/install-libfuse2` endpoint, the
`libfuse2Installed` status field, **and the Settings prompt in
`SettingsModal.ts`** (see CHANGELOG, "Removed the libfuse2 first-run gate").
`grep -ri libfuse src/` returns nothing today. The requirement is moot rather
than outstanding, and is recorded here so a future reader does not go looking
for a gate to implement.

### Findings — surfaced by task 5 step 3, deliberately NOT fixed there

Task 5's grep for host-assuming affordances surfaced three more, all in the
**Server** section, which task 5 does not gate. Recorded rather than fixed,
because gating the Server section is a scoped decision and not part of SP4
decision 4's locked list.

| # | Affordance | In a container | Assessment |
|---|---|---|---|
| 20.4 | **"install for all users"** (Linux-only) | POSTs `/api/service/install-system-wide`, which runs `pkexec`, relocates to `/opt` and re-execs | **Finding.** A container has no polkit and relocating inside the image is meaningless; the row is already Linux-gated but not container-gated. Needs a decision: hide it in Docker, or leave it and let it fail loudly. |
| 20.5 | **"uninstall ws-scrcpy-web"** | tears down a service/install that does not exist here | **Finding.** The container equivalent is `docker rm`. Same decision as 20.4. |
| 20.6 | **"stop server & exit"** | graceful shutdown — `adb kill-server`, service release, exit 0 | **Correct in a container, and load-bearing.** This is exactly what smoke row 12.1 asserts against `docker stop` (SIGTERM reaching node *through* `start.sh` via `tini -g`). Must NOT be gated. |

20.4 and 20.5 are the two rows a container-aware Server section would cover. They
are listed as one decision because they share a cause: both are install-lifecycle
affordances whose lifecycle the container owns instead.
