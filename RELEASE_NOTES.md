# Release Notes

Release notes are generated automatically from `CHANGELOG.md` via `scripts/extract-changelog.mjs` when the release workflow runs (`.github/workflows/release.yml`).

To preview the notes for the next release locally:

```bash
node scripts/extract-changelog.mjs v0.1.0
```

To preview the unsigned-mode warning block (used until SignPath Foundation approval lands):

```bash
node scripts/extract-changelog.mjs v0.1.0 --unsigned
```

This file exists as a discoverable entry point. For actual release content, see `CHANGELOG.md`. For the release procedure, see `docs/RELEASING.md`.
