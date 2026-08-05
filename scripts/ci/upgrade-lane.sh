#!/usr/bin/env bash
# The upgrade lane: `init` at the PREVIOUS release tag -> `update` to HEAD -> prove green.
#
# WHY THIS EXISTS. Every `migrations.json` record this repo has ever shipped was reviewed
# by reading it. The 0.2.0 changelog records an update-planted defect that was found "by
# running the real upgrade, not by reading the plan" — a manual act with no CI successor,
# so the next one would not be found at all. `bootstrap-linux` proves a FRESH scaffold is
# green; nothing proved that an EXISTING install survives the release. Those are different
# claims: a fresh scaffold has no manifest history, no ramp to be pre- or post-, no seeded
# drift, and no planted-vs-withheld decision to get wrong.
#
# This lane is the release gate for every ramp and migration claim in the release: a
# `migrations.json` record is not trustworthy until an `update` has actually executed.
#
# Usage: scripts/ci/upgrade-lane.sh [workdir]   (default: .selftest/upgrade)
# Requires: git with tags (fetch-depth: 0), node >= 22, corepack/pnpm.
# SOURCE: docs/harness/README.md (the release acceptance matrix) [corpus: harness/doctrine]
set -euo pipefail

# THE LANE SIMULATES A CONSUMER, AND A CONSUMER DOES NOT HAVE THE ESCAPE HATCH SET.
# HARNESS_ALLOW_SELF_EDIT=1 disarms the write guard, the commit-not-dirty rules, and the
# generator refusals — so a maintainer with it exported (which is how you work ON this
# repo) would run a lane that silently checks LESS than CI's, and the first honest run
# would be the one on the PR. That is exactly what happened on the run that shipped this
# line: the lane was green locally and red in CI, and the red was real. Unset, never
# `export ...=0` — the checks test for the literal '1', but an inherited variable is the
# kind of thing a later check might merely test for presence of.
unset HARNESS_ALLOW_SELF_EDIT

# AND NO GITHUB PR CONTEXT REACHES THE SCAFFOLD EITHER. The subject of this lane is an
# install in its own throwaway repository with no remote, so a leaked GITHUB_BASE_REF
# makes the append-only migrations check diff against an `origin/main` that does not
# exist there — and it fails CLOSED under CI, correctly, because it genuinely cannot
# verify append-only. This was scoped to the one validate call below and therefore did
# NOT cover the `graduate` subprocess, which runs the same chain: the lane's own validate
# was green and graduate's identical run was red, in CI only. Script-wide is the only
# scope that is actually true — every command here runs against that scaffold.
unset GITHUB_BASE_REF

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="${1:-$ROOT/.selftest/upgrade}"
PREV_TREE="$WORK/prev"
SCAFFOLD="$WORK/install"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mupgrade-lane: FAIL — %s\033[0m\n' "$*" >&2; exit 1; }

# ── 0. resolve the previous release tag ──────────────────────────────────────────
# The newest v* tag STRICTLY BELOW HEAD's package.json version. Strictly-below matters:
# on the release tag push HEAD is itself tagged, and upgrading from the version you are
# is not an upgrade — it is a no-op that would pass this lane while proving nothing.
HEAD_VERSION="$(node -p "require('$ROOT/package.json').version")"
say "HEAD is v$HEAD_VERSION"

PREV_TAG="$(
  git -C "$ROOT" tag --list 'v*' --sort=-v:refname |
    while read -r t; do
      # `sort -V -C` succeeds when its input is already in version order, so a
      # candidate is "below HEAD" exactly when candidate,HEAD is sorted and unequal.
      cand="${t#v}"
      [ "$cand" = "$HEAD_VERSION" ] && continue
      if printf '%s\n%s\n' "$cand" "$HEAD_VERSION" | sort -V -C; then echo "$t"; break; fi
    done
)"

# Fail closed, never skip: a lane that cannot find its baseline has not proven the
# upgrade path, and a green skip is exactly the silent downgrade this release deletes.
# The remedy is a real one (fetch tags), so this is actionable rather than fatalistic.
[ -n "$PREV_TAG" ] || die "no release tag below v$HEAD_VERSION is reachable.
  The lane needs the previous release to install FROM. In CI: actions/checkout with
  \`fetch-depth: 0\` (and tags). Locally: \`git fetch --tags\`."
say "upgrading from $PREV_TAG -> v$HEAD_VERSION"

rm -rf "$WORK"
mkdir -p "$WORK"

# ── 1. install the PREVIOUS release into a scratch dir ───────────────────────────
# A worktree, not a checkout: the lane must not disturb the tree CI is testing.
git -C "$ROOT" worktree add --detach --quiet "$PREV_TREE" "$PREV_TAG"
trap 'git -C "$ROOT" worktree remove --force "$PREV_TREE" >/dev/null 2>&1 || true' EXIT

say "init at $PREV_TAG"
node "$PREV_TREE/installer/cli.mjs" init --dir "$SCAFFOLD" --tier core --yes

cd "$SCAFFOLD"
git init -q -b main
git add -A
git -c user.email=selftest@localhost -c user.name=selftest commit -qm "scaffold at $PREV_TAG"
corepack enable >/dev/null 2>&1 || true
corepack prepare --activate >/dev/null 2>&1 || true

say "pnpm install (at $PREV_TAG)"
pnpm install --no-frozen-lockfile

# The scaffold's Supabase CLI is a catalog-pinned devDependency at node_modules/.bin,
# which is not on a plain shell's PATH — and run-rls.mjs spawns `supabase` bare.
PATH="$SCAFFOLD/node_modules/.bin:$PATH"
export PATH

BEFORE="$(node -p "require('$SCAFFOLD/.harness/manifest.json').harnessVersion")"
[ "$BEFORE" = "${PREV_TAG#v}" ] || die "manifest records $BEFORE after init at $PREV_TAG"

# ── 2. run HEAD's update ─────────────────────────────────────────────────────────
say "update -> v$HEAD_VERSION"
node "$ROOT/installer/cli.mjs" update --dir "$SCAFFOLD" | tee "$WORK/update.log"

AFTER="$(node -p "require('$SCAFFOLD/.harness/manifest.json').harnessVersion")"
[ "$AFTER" = "$HEAD_VERSION" ] || die "update did not advance harnessVersion ($BEFORE -> $AFTER, expected $HEAD_VERSION)"
BASE_AFTER="$(node -p "require('$SCAFFOLD/.harness/manifest.json').baseVersion")"
[ "$BASE_AFTER" = "$BEFORE" ] ||
  die "update advanced baseVersion ($BEFORE -> $BASE_AFTER). baseVersion is the vintage of SEEDED content and only a human \`graduate\` moves it — an update that moves it silently arms every ramped check it was protecting."
say "manifest: harnessVersion $BEFORE -> $AFTER, baseVersion held at $BASE_AFTER"

# ── 3. the plant-vs-withhold contract, asserted rather than reviewed ─────────────
# The 0.2.0 hazard, repeated deliberately: a gate that FAILS CLOSED without its data
# file must have that file planted by `update`, and a file whose gate reads
# absent-as-empty must NOT be, or the update lands foreign prose in someone's PR.
say "plant-vs-withhold"
for f in tools/approved-tools.json tools/secret-patterns.json tools/doctrine-symbols.json; do
  [ -f "$SCAFFOLD/$f" ] || die "$f must be PLANTED by update — its gate fails closed without it"
  echo "  planted:   $f"
done
for f in tools/retrofit-accept.json tools/secret-scan-allow.json; do
  [ ! -f "$SCAFFOLD/$f" ] ||
    die "$f must be TOLERATED-ABSENT, not planted — its gate reads absent-as-empty, and planting it ships a reviewed-acceptance file nobody reviewed"
  echo "  withheld:  $f"
done

# ── 4. the injected chain steps are present AND run ──────────────────────────────
# harness.config.mjs is SEEDED, so `update` never overwrites it: the configSteps
# injection is the ONLY way a new step reaches an existing install. If the injection
# silently no-ops, the consumer's chain is a release behind with every gate green.
say "injected chain steps"
node tools/validate.mjs --list > "$WORK/steps.txt"
for step in wiring secrets; do
  grep -qE "^$step  " "$WORK/steps.txt" ||
    die "step \`$step\` is absent from the upgraded install's chain — the migrations.json configSteps injection did not reach tools/harness.config.mjs.
$(cat "$WORK/steps.txt")"
  echo "  injected:  $step"
done
STEP_COUNT="$(wc -l < "$WORK/steps.txt" | tr -d ' ')"
say "chain is $STEP_COUNT steps"

# ── 5. doctor: 0 (clean) or 2 (advisory), NEVER 1 ────────────────────────────────
# 1 is doctor's "this install is broken" code. An upgrade that leaves an install
# broken is the failure this lane exists to catch, and the asymmetry matters: 2 is a
# reviewed advisory (parked upgrades, seeded divergence), which an upgrade may
# legitimately produce.
say "doctor"
set +e
node "$ROOT/installer/cli.mjs" doctor --dir "$SCAFFOLD" | tee "$WORK/doctor.log"
DOCTOR_CODE="${PIPESTATUS[0]}"
set -e
case "$DOCTOR_CODE" in
  0) echo "  doctor: clean (0)" ;;
  2) echo "  doctor: advisory (2)" ;;
  *) die "doctor exited $DOCTOR_CODE — an update must never leave an install broken" ;;
esac

# ── 6. THE GATE on the upgraded install ──────────────────────────────────────────
# --report-all, not --min-floor: the floor is HEAD's frozen snapshot, and what this
# lane has to prove is that the CONSUMER'S OWN chain — the one the injection just
# edited, the one the Stop hook runs — is green.
# GITHUB_BASE_REF is unset script-wide at the top, for the reason recorded there.
say "validate --report-all on the upgraded install"
set +e
HARNESS_REQUIRE_TOOLCHAINS=1 node tools/validate.mjs --report-all |
  tee "$WORK/validate.log"
VALIDATE_CODE="${PIPESTATUS[0]}"
set -e
[ "$VALIDATE_CODE" -eq 0 ] || die "validate is RED on the upgraded install (exit $VALIDATE_CODE) — see $WORK/validate.log"

# ── 7. every ramp NOTE names the release it expires in ───────────────────────────
# The clock, proven on the one install shape that can carry a ramp at all. A fresh
# scaffold has no manifest vintage and never ramps, so bootstrap-linux cannot see this.
say "ramp deadlines"
RAMP_NOTES="$(grep -F 'ramp: live from baseVersion' "$WORK/validate.log" || true)"
[ -n "$RAMP_NOTES" ] ||
  die "the upgraded install produced ZERO ramp NOTEs. This install's baseVersion is $BASE_AFTER and v$HEAD_VERSION ships ramped checks above it, so a clean run means the ramp machinery did not engage — and an assertion over an empty set is not a proof."
UNDATED="$(printf '%s\n' "$RAMP_NOTES" | grep -Fv 'expires in' || true)"
if [ -n "$UNDATED" ]; then
  die "ramp NOTE(s) with no deadline — a ramp with no expiry is a check shipped disabled:
$UNDATED"
fi
printf '%s\n' "$RAMP_NOTES" | sed 's/^/  /'

# ── 8. graduate REFUSES while NOTEs stand ────────────────────────────────────────
# `graduate` advances baseVersion, which arms every ramped check at once. Its counting
# behaviour — refuse while any NOTE remains — is the thing that makes a ramp an escape
# with a door rather than a permanent downgrade, and it has never executed in CI.
say "graduate must refuse while ramp NOTEs stand"
set +e
node "$ROOT/installer/cli.mjs" graduate --dir "$SCAFFOLD" > "$WORK/graduate.log" 2>&1
GRAD_CODE=$?
set -e
cat "$WORK/graduate.log"
[ "$GRAD_CODE" -ne 0 ] ||
  die "graduate SUCCEEDED with ramped findings outstanding — it would arm every ramped check on an install that has not swept them"
grep -q 'still outstanding' "$WORK/graduate.log" ||
  die "graduate refused, but not for the ramp reason — the refusal must name the outstanding findings"
BASE_FINAL="$(node -p "require('$SCAFFOLD/.harness/manifest.json').baseVersion")"
[ "$BASE_FINAL" = "$BASE_AFTER" ] || die "a refused graduate still moved baseVersion ($BASE_AFTER -> $BASE_FINAL)"

say "upgrade-lane: OK — $PREV_TAG -> v$HEAD_VERSION is validate-green on $STEP_COUNT steps, doctor $DOCTOR_CODE, every ramp NOTE dated, graduate refusing"
