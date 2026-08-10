#!/usr/bin/env bash
# consumer-ci-static: the SHIPPED CI's entry path, executed — both directions.
#
# WHY THIS EXISTS. Every job in template/base/github/workflows/quality-gate.yml begins the
# same way: setup-node with `cache: pnpm`, then `pnpm install --frozen-lockfile`. Nothing
# anywhere had ever EXECUTED that entry path on a fresh scaffold — bootstrap-linux installs
# with --no-frozen-lockfile before its first validate, and every consumer-lane claim in
# tests/canary/injections.json#lanes rests on the steps that run AFTER the install. The
# 0.6.0 web-e2e lesson (injections.json:560) is that an executed lane finds what a reading
# cannot: that lane shipped for two releases unable to reach its first assertion, green
# throughout. This lane is the same move one layer earlier — the first thing a consumer's
# very first push executes.
#
# WHAT IT PROVES, in order:
#   1. THE FAILING ORDER IS DETECTED: a scaffold committed before `pnpm install` (the
#      harness's own bootstrap-lane order) has no pnpm-lock.yaml, and the shipped entry
#      step must die with the exact frozen-lockfile refusal. A lane that cannot see the
#      defect class proves nothing about its absence.
#   2. THE GUIDANCE IS SUFFICIENT: following init's next-steps note LITERALLY (pnpm
#      install, then commit — the first commit must include pnpm-lock.yaml) yields a tree
#      on which the static job's steps complete: `pnpm install --frozen-lockfile` succeeds
#      and `node tools/validate.mjs --min-floor` is green under HARNESS_REQUIRE_TOOLCHAINS.
#
# The replay is VERBATIM where a shell can be: the pnpm-install invocation is spelled
# exactly as the workflow spells it, the validate step carries the job-level
# HARNESS_REQUIRE_TOOLCHAINS=1. setup-node's cache semantics cannot be replayed outside
# Actions — but its `node-version-file: .node-version` input is a real precondition (the
# job dies there if the file is missing), so that half is asserted as a file fact.
# scripts/check-ci-preconditions.mjs is the per-commit static closure over the same
# claims; this lane is their execution.
#
# Usage: scripts/ci/consumer-ci-static.sh [workdir]
#        (default workdir .selftest/consumer-ci)
# SOURCE: template/base/github/workflows/quality-gate.yml (the static job) ·
#         installer/commands/init.mjs (the next-steps note under test)
set -euo pipefail

# THE LANE SIMULATES A CONSUMER, AND A CONSUMER DOES NOT HAVE THE ESCAPE HATCH SET — nor
# any PR context. Same reasoning, verbatim, as upgrade-lane.sh: an inherited
# HARNESS_ALLOW_SELF_EDIT makes a local run check LESS than CI's, and a leaked
# GITHUB_BASE_REF points the append-only migrations check at a remote the scaffold's own
# throwaway repository does not have.
unset HARNESS_ALLOW_SELF_EDIT
unset GITHUB_BASE_REF

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${1:-$ROOT/.selftest/consumer-ci}"
SCAFFOLD="$WORK/install"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mconsumer-ci-static: FAIL — %s\033[0m\n' "$*" >&2; exit 1; }

rm -rf "$WORK"
mkdir -p "$WORK"

# ── 1. a fresh scaffold, committed BEFORE any install ─────────────────────────────
# The init invocation mirrors the other lanes' standard answers (upgrade-lane.sh §1,
# bootstrap-linux), and the git-then-corepack order is the harness's own bootstrap-lane
# order — which is exactly the order that produces the lockfile-less first commit this
# lane's failing half is about.
say "init at HEAD"
node "$ROOT/installer/cli.mjs" init --dir "$SCAFFOLD" --tier core --yes

cd "$SCAFFOLD"
git init -q -b main
git add -A
git -c user.email=selftest@localhost -c user.name=selftest commit -qm 'scaffold baseline (committed before any install — no lockfile yet)'
corepack enable >/dev/null 2>&1 || true
corepack prepare --activate >/dev/null 2>&1 || true

# setup-node's one replayable input: the job reads `node-version-file: .node-version` and
# dies before its first run step if the file is absent — a real entry-path precondition.
[ -f .node-version ] ||
  die ".node-version is missing from the scaffold — the shipped static job's setup-node step (node-version-file: .node-version) dies before the first run step ever executes"

# ── 2. the failing order, executed: the entry step must SEE the missing lockfile ──
# The invocation below is the static job's, verbatim — flags included. It must refuse,
# and it must refuse for the right reason: pnpm's frozen-lockfile error, not some other
# death that happens to be red.
say "the failing order — commit without install must die at the frozen-lockfile entry step"
set +e
pnpm install --frozen-lockfile > "$WORK/install-no-lockfile.log" 2>&1
NO_LOCK_CODE=$?
set -e
if [ "$NO_LOCK_CODE" -eq 0 ]; then
  die "pnpm install --frozen-lockfile SUCCEEDED on a scaffold with no committed lockfile — the shipped entry step cannot detect the commit-before-install order, so the init guidance is unenforced prose. See $WORK/install-no-lockfile.log"
fi
grep -Eq 'ERR_PNPM_NO_LOCKFILE|frozen-lockfile' "$WORK/install-no-lockfile.log" ||
  die "the entry step failed, but not with the frozen-lockfile refusal — a different death is a different defect, not proof this one is detected:
$(tail -8 "$WORK/install-no-lockfile.log")"
echo "  refused (exit $NO_LOCK_CODE), naming the lockfile:"
grep -E 'ERR_PNPM_NO_LOCKFILE|frozen-lockfile' "$WORK/install-no-lockfile.log" | head -2 | sed 's/^/    /'

# ── 3. the guidance order: init's next-steps note, followed literally ─────────────
# "next: pnpm install, then git init (if new) and COMMIT — the first commit must include
# pnpm-lock.yaml". The consumer types a bare `pnpm install` on a laptop with no CI env
# var, so the replay strips CI here — under CI=true pnpm flips the SAME bare invocation
# to frozen, which is the ambiguity check-ci-preconditions.mjs refuses in shipped
# workflows. The scaffold's baseline commit already exists, so the note's "first commit
# must include pnpm-lock.yaml" is modelled as the follow-up commit that puts the lockfile
# in history — the tree the static job checks out is byte-identical either way.
say "the guidance order — pnpm install, then commit the lockfile, per init's next-steps"
env -u CI pnpm install > "$WORK/install.log" 2>&1 ||
  die "the consumer-side \`pnpm install\` failed — the guidance cannot be followed at all. See $WORK/install.log"
git add -A
git -c user.email=selftest@localhost -c user.name=selftest commit -qm 'chore: commit pnpm-lock.yaml (the init next-steps instruction)'
git ls-files --error-unmatch pnpm-lock.yaml >/dev/null 2>&1 ||
  die "pnpm-lock.yaml is not tracked after following the guidance — either the install wrote no lockfile or .gitignore excludes it, and both mean the next-steps note instructs the impossible"

# ── 4. the static job, replayed step for step on the guided tree ──────────────────
say "replaying the shipped static job (quality-gate.yml)"
corepack enable >/dev/null 2>&1 || echo "  corepack enable: not permitted here (the Actions runner allows it; pnpm is already active)"

say "pnpm install --frozen-lockfile (the entry step, on the committed lockfile)"
pnpm install --frozen-lockfile 2>&1 | tee "$WORK/install-frozen.log" | tail -4
[ "${PIPESTATUS[0]}" -eq 0 ] ||
  die "pnpm install --frozen-lockfile FAILED on the tree the init guidance produces — the guidance is insufficient, and every consumer's first push dies at the entry step. See $WORK/install-frozen.log"

say "validate --min-floor (toolchains required — the static job's gate)"
set +e
HARNESS_REQUIRE_TOOLCHAINS=1 node tools/validate.mjs --min-floor 2>&1 | tee "$WORK/validate.log"
VALIDATE_CODE="${PIPESTATUS[0]}"
set -e
[ "$VALIDATE_CODE" -eq 0 ] ||
  die "the shipped static job's validate step is RED (exit $VALIDATE_CODE) on a fresh scaffold that followed the init guidance to the letter — a consumer's first push fails their merge gate out of the box. See $WORK/validate.log"

say "consumer-ci-static: OK — the failing order refused at the entry step (exit $NO_LOCK_CODE), and the guided tree completed the static job (install + validate --min-floor green)"
