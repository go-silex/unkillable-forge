# Engine changelog

## [1.0.1]

- Read Worker marks revision-namespace and reader-profile shell-path responses `x-robots-tag: noindex, nofollow, noarchive` via one path classifier/finalizer (including encoded prefixes, malformed revision suffixes, login redirects/method denials, and binding/bundle failures that still expose the profile shell list).
- No migration; code-only rollback to 1.0.0 stays compatible.

## [1.0.0]

- First CI-qualified engine release baseline for manage + read Workers, D1 migrations, and operator deploy tooling (F11).
- Declares `rollbackCompatibleFrom` so code-only rollback stays on the same R2/D1 without restoring old data or rights.
