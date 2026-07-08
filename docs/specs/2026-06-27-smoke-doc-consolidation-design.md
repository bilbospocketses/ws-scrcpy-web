# Smoke-test doc consolidation — design

**Date:** 2026-06-27
**Status:** approved (design)
**Scope:** `docs/smoke-tests/` — collapse three overlapping smoke-test documents into one.

## Problem

The smoke test currently lives in three files that restate the *same* ~100 test rows
(Modules 1–19) in three different wordings:

| File | Lines | Organizing principle | Job |
|---|---|---|---|
| `smoke-full.md` | 324 | by module / feature | canonical reference ("the repo doc wins") |
| `smoke-runbook.md` | 1060 | by module, **plain-English** + jargon key | low-cognitive-load twin; ASCII tables |
| `smoke-checklist.md` | 271 | by **execution order** (app state) | the sheet you actually tick through a run |

≈1,655 lines across three files for one underlying row set. Every test change must be applied
three times and hand-kept in sync — the files even carry explicit drift-management language
("if the two disagree, the repo doc wins — tell me and I'll re-sync"), which is a standing
admission that the sync is manual and lossy.

The three docs are **not** pure duplication, though. They encode three legitimately different
axes of value that genuinely conflict inside a single *linear* document:

1. **Module order** — for lookup ("what do we test about Updates?").
2. **Execution order** — for running a pass top-to-bottom (state carries between rows).
3. **Plain-English + glossary** — so the reader needn't already know `bin_t` / userns / ETXTBSY.

## Key insight

The duplication is in the **row content**. The three files are really three **views** of that
content. So: single-source the rows **once**, give every row a stable anchor, and turn the other
two axes into thin **navigation layers that hold links, not restated rows** — a link-only view
cannot drift because it carries no content.

## Decisions (locked)

- **One file**, `docs/smoke-tests/smoke-test.md`.
- **Spine = execution order.** The run-order phases (`#6`, `#7`, `#7A`, …) are the full-text body
  you tick straight through — the doc's primary *use* is running a pass.
- **Jargon = glossary + terse rows.** Carry the runbook's jargon key as one anchored Glossary
  section; rows stay terse (expert wording) and link a term to its glossary anchor on first use.
  The runbook's *inline* per-row re-explanation (most of its 1,060 lines) is dropped.
- **Markdown tables**, not the runbook's fixed-width ASCII — they render with anchors/links and
  are far easier to maintain. The `☐` tick column is kept.
- **Delete** all three former docs — `smoke-full.md`, `smoke-runbook.md`, `smoke-checklist.md` (git preserves history). No redirect stubs. (`smoke-test.md` is a new file rather than an in-place rename of any one of them.)

## Target structure

```
# ws-scrcpy-web — Smoke Test
> Smoke target: vX        ← the ONE line to bump per release (was 3 lines in 3 files)

§ How to use              mark x/F/- · stop rule · platform-tag legend
§ Pre-flight setup        Fedora / Ubuntu+Kubuntu / update-from build / device / Windows /
                          no-libfuse2 / capture scripts / manual recovery block
§ Glossary            ⚓   SELinux, AppArmor, userns, bin_t, var_lib_t, fcontext, restorecon,
                          pkexec, AppImage, FUSE, ETXTBSY, flock, Velopack, …  (each #anchored)
§ Index by module     ⚓   Module 1 → #t-1-1 …; 2 → …; 2b → …  (link-only reference view)
§ The run  (BODY)         #6 First install → #7 Current checks → #7A Browser UX → #7B Ubuntu →
                          #8 → #9 → #10 → #11 → #12 → #13 → #14 → #15 → #16 → #18 → #19
                          each row:  <id ⚓> | platform | do this | expected + verify | ☐
§ Global pass criteria    + Stop-and-report
```

## Synthesis rule (nothing is lost)

For each test row in the merged body:

- **Ordering** comes from `smoke-checklist.md`'s execution phases.
- **Row content authority** is `smoke-full.md`'s text. Where the checklist abbreviated a row,
  the fuller "expected + verify" wording from `smoke-full.md` (the current source of truth) is
  what lands. The canonical authority *moves into* the run-order doc; it is not demoted.
- **Terminology** comes from `smoke-runbook.md`'s jargon key → the single Glossary section.
- **Module lookup** becomes the anchor index — not a second copy of the rows.

Single-sourced once (were repeated in 2–3 files): the smoke-target version line, the platform-tag
legend, Pre-flight setup, the capture-scripts / clear-install instructions, the manual recovery
block, Global pass criteria, and Stop-and-report.

## Anchor scheme

- Test rows: `<a id="t-2b-1"></a>` in the first cell, rendered next to the bold id (`**2b.1**`).
  Rule — every `.` becomes `-`, prefix `t-`: `1.2` → `t-1-2`, `2b.1` → `t-2b-1`,
  `4.2-system-gui` → `t-4-2-system-gui` (existing hyphens kept).
- Glossary terms: `<a id="g-bin_t"></a>`; rows link `[bin_t](#g-bin_t)` on first use in the body.
- The "Index by module" section is a list of `[1.2](#t-1-2)`-style links grouped by module.

## Migration / change set

1. Write `docs/smoke-tests/smoke-test.md` per the structure above.
2. `git rm` all three: `docs/smoke-tests/smoke-full.md`, `smoke-runbook.md`, `smoke-checklist.md`.
3. Internal links in the new doc point at `clear-install.sh` / `capture-logs.sh` / `capture-logs.ps1`,
   which keep their names — no script changes.
4. **Memory (separate, codeword-gated edit):** update `breadcrumb_ws_scrcpy_web.md` line 31
   (the `{smoke-full,smoke-runbook,smoke-checklist}.md` trio reference → `smoke-test.md`); light
   touch on `todo_ws_scrcpy_web.md` folder references; check `reference_ws_scrcpy_version_bump`
   for a "bump the smoke target in 3 files" step and collapse it to one.

## Non-goals / out of scope

- No change to test **content** beyond merging wordings — same coverage, same ids, same platform tags.
- The three scripts (`clear-install.sh`, `capture-logs.sh`, `capture-logs.ps1`) are untouched.
- Historical `docs/plans/`, `docs/specs/`, and `memory/archive/*` references to the old filenames
  are point-in-time records and are left as-is.
- No new automation; this is a documentation reorganization only.

## Success criteria

- One file under `docs/smoke-tests/` holds the entire smoke; `smoke-full.md`, `smoke-runbook.md`,
  and `smoke-checklist.md` are gone.
- Every test row (Modules 1–19) appears exactly once, with a stable anchor.
- Run-order (body), module-lookup (index), and term-lookup (glossary) all work from the one doc.
- The smoke-target version is bumped in exactly one place.
- No dangling references in live (non-historical) repo or memory locations.
