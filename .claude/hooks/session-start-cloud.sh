#!/bin/bash
# Cloud sessions only: install the workspace and fetch full history + tags.
# Always exits 0: a bootstrap problem must never stop a session; it is reported instead.
[ "$CLAUDE_CODE_REMOTE" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR" || exit 0
if [ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "true" ]; then
  git fetch --quiet --unshallow --tags origin || echo "session-start: git fetch --unshallow failed" >&2
else
  git fetch --quiet --tags origin || echo "session-start: git fetch --tags failed" >&2
fi
pnpm install --frozen-lockfile --prefer-offline >/dev/null 2>&1 \
  || echo "session-start: pnpm install failed; run it by hand" >&2
exit 0
