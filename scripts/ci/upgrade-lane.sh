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
# Usage: scripts/ci/upgrade-lane.sh [workdir] [--from <tag>]
#        (default workdir .selftest/upgrade; default tag = newest release below HEAD)
# Requires: git with tags (fetch-depth: 0), node >= 22, corepack/pnpm.
# SOURCE: docs/harness/README.md (the release acceptance matrix) [corpus: harness/doctrine]
#
# ── 0.4.0: `--from`, and why the lane could not previously execute an EXPIRY ──────
#
# `rampNote` short-circuits at `if (cmpDotted(base, minVersion) >= 0) return false`,
# BEFORE it ever reads the deadline. The default leg installs the PREVIOUS release, so
# its baseVersion is one minor below HEAD — already at or above the minVersion of every
# ramp old enough to be expiring. Those checks are therefore already live on the default
# leg's install and the `RAMP EXPIRED` branch is unreachable on it, for every release,
# structurally. The single largest behavioural change in 0.4.0 would have shipped with no
# lane able to execute it. `--from` fixes that: a leg at an OLD baseline is the only shape
# that meets a deadline.
#
# ── and why the "at least one NOTE" assertion had to go ──────────────────────────
#
# Step 7 used to `die` when the upgraded install emitted no ramp NOTE at all. Read as a
# rule, that says: every release must ship a ramp whose minVersion equals itself, or fail
# this lane. Nobody decided that. It is satisfiable only by inventing an escape for a
# check that does not need one — the exact "green but bad" shape this repo deletes. What
# replaces it is an EXPECTATION SET computed from HEAD's own shipped call sites for this
# leg's baseline: the NOTEs that must appear, the expiries that must fire, and — when
# both are empty — the assertion that `graduate` SUCCEEDS, which is correct for that
# install and had never been executed anywhere.
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
WORK=""
FROM_TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM_TAG="${2:-}"; [ -n "$FROM_TAG" ] || { echo "--from needs a tag" >&2; exit 2; }; shift 2 ;;
    --from=*) FROM_TAG="${1#--from=}"; shift ;;
    -*) echo "upgrade-lane: unknown option $1" >&2; exit 2 ;;
    *) WORK="$1"; shift ;;
  esac
done
WORK="${WORK:-$ROOT/.selftest/upgrade}"
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

if [ -n "$FROM_TAG" ]; then
  git -C "$ROOT" rev-parse -q --verify "refs/tags/$FROM_TAG" >/dev/null ||
    die "--from $FROM_TAG: no such tag. Fetch tags (\`git fetch --tags\`, or fetch-depth: 0 in CI)."
  printf '%s\n%s\n' "${FROM_TAG#v}" "$HEAD_VERSION" | sort -V -C ||
    die "--from $FROM_TAG is not BELOW v$HEAD_VERSION — upgrading from the version you are is a no-op that would pass this lane while proving nothing."
  PREV_TAG="$FROM_TAG"
else
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
fi

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
# 2>&1, and it is load-bearing. validate.mjs captures each child's stdout AND stderr, but
# re-emits a FAILING step's output on its OWN stderr — so a plain `| tee` logged the passing
# steps and dropped the failures, which is precisely the half this leg exists to read. Leg B
# caught it: six gates printed `RAMP EXPIRED` and validate.log contained one.
say "validate --report-all on the upgraded install"
set +e
HARNESS_REQUIRE_TOOLCHAINS=1 node tools/validate.mjs --report-all 2>&1 |
  tee "$WORK/validate.log"
VALIDATE_CODE="${PIPESTATUS[0]}"
set -e

# ── 7. the ramp EXPECTATION SET, computed rather than assumed ────────────────────
# Which deadlines this leg's baseline actually meets, derived from HEAD's own shipped
# call sites by the same classifier the ledger and the unit tests use. Three outcomes,
# each with a different consequence — and the third one is the one the old
# "at least one NOTE" assertion made unreachable.
say "ramp expectations for baseVersion $BASE_AFTER on harness v$HEAD_VERSION"
node "$ROOT/scripts/ci/ramp-expectations.mjs" "$BASE_AFTER" "$HEAD_VERSION" > "$WORK/expect.sh"
cat "$WORK/expect.sh" | sed 's/^/  /'
# shellcheck source=/dev/null
. "$WORK/expect.sh"

# NARROW TO WHAT THIS LANE ACTUALLY RUNS, and say what was dropped.
#
# The expectation covers every shipped ramp site; this step ran `validate`, which is the
# 31-step chain and NOT the 9-step Stop chain. diff-coverage, duplication, i18n,
# test-quality and mobile-perf ramp on the Stop side, so asserting their NOTEs against
# validate.log would fail on a lane that is behaving correctly. Filtering silently would be
# worse than the bug: a gate that quietly leaves the expectation set is a gate nobody is
# checking, which is this repository's whole subject. So it is filtered AND printed.
CHAIN_STEPS="$(cut -d' ' -f1 < "$WORK/steps.txt" | tr '\n' ' ')"
in_chain() { case " $CHAIN_STEPS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
narrow() {
  local kept="" dropped=""
  for g in $1; do
    if in_chain "$g"; then kept="$kept $g"; else dropped="$dropped $g"; fi
  done
  [ -z "$dropped" ] || echo "  not in this chain (Stop-chain gates, not asserted here):$dropped" >&2
  printf '%s' "${kept# }"
}
EXPIRED="$(narrow "$EXPIRED")"
NOTING="$(narrow "$NOTING")"

if [ -n "$EXPIRED" ]; then
  # ── 7a. deadlines MET: the alarm must actually ring, and it must be a red ───────
  # The branch no lane could reach before `--from`: every ramp old enough to expire
  # opens at a minVersion at or below the PREVIOUS release, so the default leg's
  # install is already past it and rampNote returns false at its first guard.
  say "deadlines MET — the chain must be RED, and every expiry that fires must be expected"
  [ "$VALIDATE_CODE" -ne 0 ] ||
    die "validate is GREEN on an install that meets $(printf '%s' "$EXPIRED" | wc -w | tr -d ' ') ramp deadline(s) ($EXPIRED). The escapes closed and nothing reddened — an expiry that does not fail is an alarm ringing into a green run, which is the exact defect v0.4.0 shipped to fix."

  # THE EXPECTATION IS AN UPPER BOUND, NOT AN EQUALITY, and the distinction is the gate
  # scripts' own control flow. Most call sites invoke rampNote only when the gate HAS a
  # finding to withhold — `if (rampedErrs.length > 0) { rampNote(...) }`. So a deadline this
  # install meets fires only if the finding also exists on this tree, and the reference
  # scaffold at v0.1.3 legitimately produces none for several of them (its seeded migrations
  # trip neither of the 0.2.0 migration rules, for instance). Demanding one line per
  # expiring gate asserts something the harness never promised, and the only way to make it
  # pass would be to weaken it.
  #
  # What IS asserted, and is not vacuous:
  #   - at least one expiry actually fired (this leg exists to execute that branch);
  #   - every gate that fired is one the classifier predicted (a surprise expiry means the
  #     ledger and gate.mjs disagree, which is the failure the shared module prevents);
  #   - the chain is red, above.
  # Expected-but-silent gates are REPORTED, never asserted and never hidden.
  FIRED="$(grep -oE '^[a-z0-9-]+: RAMP EXPIRED' "$WORK/validate.log" | cut -d: -f1 | sort -u | tr '\n' ' ')"
  [ -n "$FIRED" ] ||
    die "the chain is red but NOT ONE \`RAMP EXPIRED\` line appeared, on the one baseline chosen because it meets deadlines ($EXPIRED). Either the chain is red for an unrelated reason — read $WORK/validate.log — or every expiring call site discards rampNote's result and the deadline changes nothing (scripts/check-ramp-ledger.mjs)."
  for g in $FIRED; do
    case " $EXPIRED " in
      *" $g "*) echo "  expired:   $g" ;;
      *) die "gate \`$g\` printed RAMP EXPIRED but the classifier did not predict it for baseVersion $BASE_AFTER. scripts/lib/ramp-sites.mjs mirrors gate.mjs deliberately so the two cannot disagree — one of them is now wrong." ;;
    esac
  done
  for g in $EXPIRED; do
    case " $FIRED " in
      *" $g "*) ;;
      *) echo "  (silent):  $g — deadline met, but this tree carries no finding for it to withhold" ;;
    esac
  done
  grep -F 'RAMP EXPIRED' "$WORK/validate.log" | sed 's/ was ramped.*//;s/^/    /' | sort -u
elif [ "$VALIDATE_CODE" -ne 0 ]; then
  die "validate is RED on the upgraded install (exit $VALIDATE_CODE) and NO ramp deadline is met at baseVersion $BASE_AFTER — this is a real regression, not an expiry. See $WORK/validate.log"
fi

# ── 7b. every NOTE that should appear does, and every NOTE names its deadline ────
for g in $NOTING; do
  grep -q "^$g: NOTE .*ramp: live from baseVersion" "$WORK/validate.log" ||
    die "gate \`$g\` should be ramp-NOTEing at baseVersion $BASE_AFTER and is silent. A ramp that does not announce itself is a check shipped disabled with nobody told."
  echo "  noting:    $g"
done
RAMP_NOTES="$(grep -F 'ramp: live from baseVersion' "$WORK/validate.log" || true)"
UNDATED="$(printf '%s' "$RAMP_NOTES" | grep -Fv 'expires in' || true)"
if [ -n "$UNDATED" ]; then
  die "ramp NOTE(s) with no deadline — a ramp with no expiry is a check shipped disabled:
$UNDATED"
fi
[ -z "$RAMP_NOTES" ] || printf '%s\n' "$RAMP_NOTES" | sed 's/^/    /'

# ── 8. graduate: refuses while anything stands, SUCCEEDS when nothing does ────────
# `graduate` advances baseVersion, arming every ramped check at once. Both directions
# matter and only the refusal was ever executed: the success path is what an install
# that has genuinely swept everything hits, and it is the one that MOVES the manifest.
say "graduate"
set +e
node "$ROOT/installer/cli.mjs" graduate --dir "$SCAFFOLD" > "$WORK/graduate.log" 2>&1
GRAD_CODE=$?
set -e
cat "$WORK/graduate.log"
BASE_FINAL="$(node -p "require('$SCAFFOLD/.harness/manifest.json').baseVersion")"

if [ -n "$EXPIRED$NOTING" ]; then
  [ "$GRAD_CODE" -ne 0 ] ||
    die "graduate SUCCEEDED with ramped findings outstanding ($EXPIRED$NOTING) — it would arm every ramped check on an install that has not swept them"
  grep -qE 'still outstanding|validate is RED' "$WORK/graduate.log" ||
    die "graduate refused, but not for the ramp reason — the refusal must name the outstanding findings or the red chain"
  [ "$BASE_FINAL" = "$BASE_AFTER" ] || die "a refused graduate still moved baseVersion ($BASE_AFTER -> $BASE_FINAL)"
  GRAD_SUMMARY="graduate refusing (baseVersion held at $BASE_FINAL)"
else
  # No ramp above this baseline — the legitimate empty set. Asserting "at least one NOTE"
  # here would have demanded the release invent a ramp at minVersion == itself; the real
  # obligation is the opposite one, and it had never run: graduation must WORK.
  [ "$GRAD_CODE" -eq 0 ] ||
    die "no ramp is outstanding at baseVersion $BASE_AFTER, yet graduate REFUSED (exit $GRAD_CODE) — a door that will not open when nothing blocks it is not an escape with a door. See $WORK/graduate.log"
  [ "$BASE_FINAL" = "$HEAD_VERSION" ] ||
    die "graduate exited 0 but baseVersion is $BASE_FINAL, not $HEAD_VERSION — the one thing graduation exists to do did not happen"
  GRAD_SUMMARY="graduate advancing baseVersion $BASE_AFTER -> $BASE_FINAL"
fi

say "upgrade-lane: OK — $PREV_TAG -> v$HEAD_VERSION on $STEP_COUNT steps, doctor $DOCTOR_CODE, validate exit $VALIDATE_CODE (expired: ${EXPIRED:-none}; noting: ${NOTING:-none}; inert: $INERT), $GRAD_SUMMARY"
