# Neutralise an inherited git environment. Sourced by every tests/shell script
# that touches git — including the entrypoints, so a child inherits a clean env
# and a single file run by hand is protected too.
#
# WHY. git exports GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE (plus a quarantine
# object dir on push) to its hooks, and those variables OVERRIDE both `git -C
# <path>` and the process cwd. Our fixtures build throwaway repositories in
# $TMPDIR and commit, tag and `git config` inside them, so a run that inherits
# them writes into THIS repository instead.
#
# Observed twice on 2026-09-07, in the same session:
#   · from the pre-push hook, via scripts/test-all.sh — a fixture commit
#     authored "Forge Test" landed on local main AND on a feature branch,
#     truncating wrangler.toml to one line and site/404.html to a stub, and
#     adding site/a/index.html;
#   · from a hand-run of a single test file with GIT_DIR set, which re-created
#     the same commit and re-wrote user.name/user.email into .git/config.
#
# The contract is verified by tests/shell/test_git_env_isolation.sh, which
# points GIT_DIR at a scratch repository and asserts nothing was written there.
# GIT_COMMON_DIR is in the list because git can re-resolve GIT_DIR from it in a
# linked worktree — the layout this repo actually uses.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR \
  GIT_QUARANTINE_PATH GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
