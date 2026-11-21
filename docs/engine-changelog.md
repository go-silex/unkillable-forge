# Engine changelog

## [1.0.1]

- Read Worker marks every `/_revisions/` response and every configured shell-path response (including `/login` redirects and method denials) `x-robots-tag: noindex, nofollow, noarchive`, so search engines never index superseded revisions or the sign-in surface.
- No migration; code-only rollback to 1.0.0 stays compatible.

## [1.0.0]

- First CI-qualified engine release baseline for manage + read Workers, D1 migrations, and operator deploy tooling (F11).
- Declares `rollbackCompatibleFrom` so code-only rollback stays on the same R2/D1 without restoring old data or rights.
