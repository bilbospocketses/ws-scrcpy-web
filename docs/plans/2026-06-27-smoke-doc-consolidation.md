# Smoke-test doc consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Inline execution is deliberate here: faithful row transcription needs all three source docs held in one context — see "Execution note" at the bottom.

**Goal:** Replace the three overlapping smoke-test docs (`smoke-full.md`, `smoke-runbook.md`, `smoke-checklist.md`) with one execution-ordered `docs/smoke-tests/smoke-test.md` that single-sources every row.

**Architecture:** `smoke-checklist.md` (already execution-ordered, already synced from full) is the skeleton. Enrich it with the comprehensive single-sourced front matter (Pre-flight, Glossary, Index), add a stable anchor + tick box to every row, reconcile each row's "expected + verify" text against `smoke-full.md` (the authority), then delete all three old files (the new `smoke-test.md` is a fresh file, not an in-place rename).

**Tech Stack:** Markdown (GitHub-flavored, inline HTML anchors); `ripgrep` for verification.

## Global Constraints

- Single output file: `docs/smoke-tests/smoke-test.md`. Filename is fixed.
- Spine = execution order (phases `#6 … #19`). Body is markdown tables with a `☐` column.
- Anchor rule: every `.` → `-`, prefix `t-` (`1.2`→`t-1-2`, `2b.1`→`t-2b-1`, `4.2-system-gui`→`t-4-2-system-gui`); glossary anchors `g-<term>`.
- Content authority for each row's "expected + verify" = `smoke-full.md`. Ordering = `smoke-checklist.md`.
- Same coverage: every test id in `smoke-full.md ∪ smoke-checklist.md` must survive, unchanged ids, unchanged platform tags.
- Scripts `clear-install.sh` / `capture-logs.sh` / `capture-logs.ps1` are NOT touched and keep their names.
- Smoke-target version string lives on exactly ONE line in the final doc.
- All git ops use `git -C "C:/Users/jscha/source/repos/ws-scrcpy-web"`. Branch: `smoke-doc-consolidation` (already cut from origin/main).
- `release:none` change (internal QA docs) — no product CHANGELOG entry required.

---

### Task 1: Scaffold the new doc + all single-sourced (non-row) sections

**Files:**
- Create: `docs/smoke-tests/smoke-test.md`
- Read for source text: `docs/smoke-tests/smoke-full.md` (Pre-flight, recovery, pass-criteria), `docs/smoke-tests/smoke-runbook.md` (jargon key → Glossary; How-to-use prose), `docs/smoke-tests/smoke-checklist.md` (legend, Global pass criteria, Stop-and-report)

**Produces:** the doc shell with every section present EXCEPT the run body (Task 2) and the module index (Task 3). Section order:

```
# ws-scrcpy-web — Smoke Test
> **Smoke target: `vX`** — bump this one line each release.   ← the single version line
## How to use            (x/F/- legend · stop rule · platform-tag legend — from checklist legend + runbook intro)
## Pre-flight setup      (Fedora 44 · Ubuntu 26.04 + Kubuntu · update-from build · device · Windows · no-libfuse2 · capture scripts · manual recovery block — from smoke-full Pre-flight, the fullest version)
## Glossary          ⚓   (from smoke-runbook "Jargon key"; each term gets <a id="g-..."></a>)
## Index by module   ⚓   (PLACEHOLDER heading only — filled in Task 3)
## The run           ⚓   (PLACEHOLDER heading only — filled in Task 2)
## Global pass criteria  (from smoke-checklist tail)
## Stop-and-report       (from smoke-checklist tail)
```

- [ ] **Step 1:** Read all three source docs fully (offsets as needed) so the front-matter text is copied, not paraphrased. Pre-flight comes from `smoke-full.md` lines ~20-54 (it is the most complete); Glossary from `smoke-runbook.md` lines ~22-73; legend/pass-criteria/stop-report from `smoke-checklist.md`.
- [ ] **Step 2:** Write `smoke-test.md` with the section skeleton above. Put the smoke-target version on ONE line (`vX` → the current target `v0.1.30-beta.71`). Glossary terms each carry `<a id="g-<term>"></a>` (e.g. `g-bin_t`, `g-userns`, `g-fcontext`, `g-etxtbsy`, `g-restorecon`, `g-pkexec`, `g-appimage`, `g-fuse`, `g-flock`, `g-velopack`, `g-apparmor`, `g-selinux`, `g-avc`).
- [ ] **Step 3 (verify — sections present):**

Run (Bash tool):
```bash
rg -n '^## (How to use|Pre-flight setup|Glossary|Index by module|The run|Global pass criteria|Stop-and-report)' "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/smoke-tests/smoke-test.md"
```
Expected: 7 heading lines, in that order.

- [ ] **Step 4 (verify — single version line):**

Run:
```bash
rg -c 'Smoke target' "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/smoke-tests/smoke-test.md"
```
Expected: `1`.

- [ ] **Step 5 (verify — glossary anchors exist):**

Run:
```bash
rg -c 'id="g-' "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/smoke-tests/smoke-test.md"
```
Expected: ≥ 12 (one per jargon term).

---

### Task 2: Transcribe the run-order body (all phases, every row, anchored)

**Files:**
- Modify: `docs/smoke-tests/smoke-test.md` (fill the `## The run` section)
- Read for ordering: `docs/smoke-tests/smoke-checklist.md` (phases `#6, #7, #7A, #7B, #8, #9, #10, #11, #12, #13, #14, #15, #16, #18, #19`)
- Read for authoritative row text: `docs/smoke-tests/smoke-full.md` (Modules 1–19)

**Interfaces:**
- Produces: every anchor id `t-<id>` that Task 3's index will link to. Anchor format is fixed by Global Constraints.

**Method (apply per row, in checklist phase order):**
- Keep the checklist's phase grouping and headings (`### #6 — First install`, etc.) and the phase intro notes (e.g. the #6 "order matters — 4.1 in the no-service window" note).
- For each row, the first cell is `<a id="t-<id>"></a> **<id>** <short title>`; keep the `[platform-tag]`; the "How to perform" and "Expected + verify" cells take the **fullest** wording — if `smoke-full.md`'s row says more than the checklist's, use full's. Keep the trailing `☐`.
- Link the first occurrence of each jargon term in a row to its glossary anchor, e.g. `[bin_t](#g-bin_t)` — first use in the body only, not every occurrence.

- [ ] **Step 1:** Build a coverage worklist first. Extract the id set from both source docs:
```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/smoke-tests"
rg -oN '\*\*[0-9][0-9a-z.\-]*\*\*' smoke-full.md     | tr -d '*' | sort -u > /tmp/ids-full.txt
rg -oN '\*\*[0-9][0-9a-z.\-]*\*\*' smoke-checklist.md | tr -d '*' | sort -u > /tmp/ids-check.txt
sort -u /tmp/ids-full.txt /tmp/ids-check.txt > /tmp/ids-union.txt
wc -l /tmp/ids-union.txt
```
Expected: the union id list (≈100 ids) — this is the completeness target.
- [ ] **Step 2:** Write the `## The run` body phase-by-phase, every id from `/tmp/ids-union.txt`, each with its `t-<id>` anchor. Where checklist and full disagree on an id's existence (e.g. checklist's `5.x-keepstate` vs full's `5.3a`; checklist's `4.2-system-ubuntu` vs full's `5.3b`), keep ONE row, prefer the full.md id, and note the alias in the row title so no coverage is lost.
- [ ] **Step 3 (verify — no row lost):**
```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/smoke-tests"
rg -oN 'id="t-[^"]+"' smoke-test.md | sed -E 's/id="t-(.*)"/\1/; s/-/./g' | sort -u > /tmp/ids-new.txt
comm -23 /tmp/ids-union.txt /tmp/ids-new.txt
```
Expected: empty output (every source id present in the new doc — modulo the documented id-aliases from Step 2, which the executor confirms by eye).
- [ ] **Step 4 (verify — anchors unique):**
```bash
rg -oN 'id="t-[^"]+"' "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/smoke-tests/smoke-test.md" | sort | uniq -d
```
Expected: empty (no duplicate row anchors).

---

### Task 3: Module index + anchor-integrity gate

**Files:**
- Modify: `docs/smoke-tests/smoke-test.md` (fill `## Index by module`)

**Method:** Under `## Index by module`, list each module (1, 2, 2b, 3, … 19) as a heading/line followed by its rows as links `[<id>](#t-<id>)`, in numeric id order (NOT run order — this is the by-feature lookup view). Pull the module→row grouping from `smoke-full.md`'s module structure.

- [ ] **Step 1:** Write the index: one line per module, e.g. `**Module 6 — Updates:** [6.1](#t-6-1) · [6.2](#t-6-2) · …`.
- [ ] **Step 2 (verify — every index link resolves to a real anchor):**
```bash
cd "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/smoke-tests"
rg -oN '\(#t-[^)]+\)' smoke-test.md | tr -d '()#' | sort -u > /tmp/links.txt
rg -oN 'id="t-[^"]+"' smoke-test.md | sed -E 's/id="(.*)"/\1/' | sort -u > /tmp/anchors.txt
comm -23 /tmp/links.txt /tmp/anchors.txt
```
Expected: empty (no index link points at a missing anchor).
- [ ] **Step 3 (verify — index covers all rows):**
```bash
comm -13 /tmp/links.txt /tmp/anchors.txt
```
Expected: empty (every row anchor is reachable from the index).

---

### Task 4: Delete the old docs, reconcile links, repo dangling-ref check

**Files:**
- Delete: `docs/smoke-tests/smoke-full.md`, `docs/smoke-tests/smoke-runbook.md`, `docs/smoke-tests/smoke-checklist.md`
- Verify-only: `docs/smoke-tests/smoke-test.md` internal links

- [ ] **Step 1:** Confirm `smoke-test.md` links to the scripts by their kept names:
```bash
rg -n 'clear-install\.sh|capture-logs\.(sh|ps1)' "C:/Users/jscha/source/repos/ws-scrcpy-web/docs/smoke-tests/smoke-test.md"
```
Expected: present; no link points at `smoke-full.md`/`smoke-runbook.md`.
- [ ] **Step 2:** Remove the two old docs:
```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" rm docs/smoke-tests/smoke-full.md docs/smoke-tests/smoke-runbook.md docs/smoke-tests/smoke-checklist.md
```
- [ ] **Step 3 (verify — no live ref dangles):** historical plans/specs/archive and the consolidation spec+plan legitimately name the old files; everything else must be clean.
```bash
rg -l 'smoke-full|smoke-runbook' "C:/Users/jscha/source/repos/ws-scrcpy-web" \
  -g '!docs/plans/**' -g '!docs/specs/**'
```
Expected: empty (README, scripts, source, the new doc — none reference the deleted files).

---

### Task 5: Memory updates (codeword authorized) + memory dangling check

**Files (memory vault, absolute paths):**
- Modify: `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/breadcrumb_ws_scrcpy_web.md` (line ~31 trio reference → `smoke-test.md`)
- Modify: `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/todo_ws_scrcpy_web.md` (folder-level refs; no filename change needed unless one names the trio)
- Check/modify: `C:/Users/jscha/.claude/projects/C--Users-jscha/memory/reference_ws_scrcpy_version_bump.md` (if it lists bumping the smoke target in 3 files, collapse to one: `smoke-test.md`)

- [ ] **Step 1:** Update the breadcrumb pointer line from `smoke docs docs/smoke-tests/{smoke-full,smoke-runbook,smoke-checklist}.md` to `smoke doc docs/smoke-tests/smoke-test.md`.
- [ ] **Step 2:** Read `reference_ws_scrcpy_version_bump.md`; if it enumerates the smoke-target bump across the three files, replace with the single `smoke-test.md` line. If it doesn't mention them, leave it.
- [ ] **Step 3:** Light-touch `todo_ws_scrcpy_web.md` — its references are folder-level (`docs/smoke-tests/`) and stay valid; only edit if a line names the trio.
- [ ] **Step 4 (verify — only historical/archive mention the old names):**
```bash
rg -l 'smoke-full|smoke-runbook|\{smoke-full' "C:/Users/jscha/.claude/projects/C--Users-jscha/memory" -g '!archive/**'
```
Expected: empty, or only files where the mention is explicitly historical narrative.

---

### Task 6: Land the change

- [ ] **Step 1:** Review the full diff:
```bash
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" status
git -C "C:/Users/jscha/source/repos/ws-scrcpy-web" diff --stat
```
- [ ] **Step 2:** Stage + commit (spec, plan, new doc, deletions). Use the finishing-a-development-branch skill to choose merge/PR/cleanup. On a signed repo, land via `gh pr merge --squash --delete-branch` (never `--rebase`). Commit message ends with the required `Co-Authored-By` trailer.
- [ ] **Step 3 (verify):** `git -C … log --oneline -1` shows the commit; if PR'd, `gh pr view` shows it open/merged.

---

## Execution note

Inline execution (executing-plans) — not subagent-driven — because Task 2 transcribes ~100 rows that must stay faithful to three source docs simultaneously; splitting that across fresh subagents (each re-reading the sources) invites drift and lost rows. The verification gates in Tasks 2–5 are the safety net.

## Self-review (against the spec)

- **Spec coverage:** one-file output (T1–T3) ✓; run-order spine (T2) ✓; glossary+terse rows (T1 glossary, T2 first-use links) ✓; markdown tables + tick column (T2) ✓; delete-no-stubs (T4) ✓; synthesis rule / content authority (T2 method) ✓; anchor scheme (Global Constraints + T2/T3) ✓; single version line (T1 S4) ✓; migration incl. memory + version-bump ref (T5) ✓; historical refs left as-is (T4 S3 excludes) ✓; success criteria → verification gates ✓.
- **Placeholder scan:** the only `vX`/`PLACEHOLDER` tokens are explicit, resolved within their task (T1 S2 sets the version; T2/T3 fill the placeholders). No unresolved TODOs.
- **Type consistency:** anchor format `t-<id>` / `g-<term>` and the id-aliasing rule are used identically across T2 and T3; verification commands reference the same files/paths throughout.
