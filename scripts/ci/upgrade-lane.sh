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
# SOURCE: CONTRIBUTING.md §Releases (the release ladder — its step 4 is this lane) [corpus: harness/doctrine]
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
    --sweep) SWEEP=1; shift ;;
    -*) echo "upgrade-lane: unknown option $1" >&2; exit 2 ;;
    *) WORK="$1"; shift ;;
  esac
done
WORK="${WORK:-$ROOT/.selftest/upgrade}"
PREV_TREE="$WORK/prev"
SCAFFOLD="$WORK/install"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\n\033[31mupgrade-lane: FAIL — %s\033[0m\n' "$*" >&2; exit 1; }

# A file's content digest, or the literal `absent`. Node rather than sha256sum/shasum,
# which are spelled differently on the ubuntu runner and on a maintainer's macOS. `absent`
# is a real value on purpose: a lockfile missing both before and after an install compares
# EQUAL, so the caller's "it moved" assertion reds instead of quietly reading a pair of
# empty strings as a match.
# shellcheck disable=SC2016
lock_digest() {
  node -e '
    const { createHash } = require("node:crypto")
    const { readFileSync } = require("node:fs")
    try {
      process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))
    } catch {
      process.stdout.write("absent")
    }
  ' "$1"
}

# ── 0. resolve the previous release tag ──────────────────────────────────────────
# The newest v* tag STRICTLY BELOW HEAD's package.json version. Strictly-below matters:
# on the release tag push HEAD is itself tagged, and upgrading from the version you are
# is not an upgrade — it is a no-op that would pass this lane while proving nothing.
HEAD_VERSION="$(node -p "require('$ROOT/package.json').version")"
say "HEAD is v$HEAD_VERSION"

if [ -n "$FROM_TAG" ]; then
  git -C "$ROOT" rev-parse -q --verify "refs/tags/$FROM_TAG" >/dev/null ||
    die "--from $FROM_TAG: no such tag. Fetch tags (\`git fetch --tags\`, or fetch-depth: 0 in CI)."
  # `sort -V -C` succeeds on an ALREADY-SORTED pair, and an equal pair is sorted — so the
  # check below alone accepts `--from v$HEAD_VERSION`, the exact self-upgrade no-op the
  # message refuses. Strictly-below needs the same skip-equal guard the auto-resolve loop
  # applies to each candidate, and on the tag push (HEAD itself tagged) equality is not a
  # hypothetical: it is the first tag a completing shell offers.
  if [ "${FROM_TAG#v}" = "$HEAD_VERSION" ] ||
    ! printf '%s\n%s\n' "${FROM_TAG#v}" "$HEAD_VERSION" | sort -V -C; then
    die "--from $FROM_TAG is not BELOW v$HEAD_VERSION — upgrading from the version you are is a no-op that would pass this lane while proving nothing."
  fi
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
#
# The prune is for the MAINTAINER, not for CI. `rm -rf "$WORK"` above deletes the
# worktree's directory but not its registration in .git/worktrees, so an interrupted run
# leaves `$PREV_TREE` "missing but already registered" and every later run dies at 128
# before doing any work. CI gets a fresh checkout and never sees it; a laptop sees it
# forever, and a lane a maintainer cannot re-run is a lane that only CI ever executes.
# Prune, not `add -f`: this clears registrations whose directory is gone and leaves a
# live worktree alone.
git -C "$ROOT" worktree prune
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

# ── 2b. the dependency channel, executed end to end (0.5.0) ──────────────────────
# 0.4.0 shipped an eslint.config.mjs importing eslint-plugin-jsx-a11y against a pin no
# UPGRADED install had, and eslint died before linting a file — the whole `lint` step, on
# every existing consumer, with a fresh scaffold perfectly green. That asymmetry is the
# only reason this lane exists, and until now the lane could not have caught it: it runs
# `pnpm install` ONCE, at the PREV_TAG scaffold in §1, and never again. So whatever
# `update` did to the dependency graph was never installed and never exercised.
#
# `update` does not write pnpm-workspace.yaml or package.json — both are SEEDED — it parks
# an OBLIGATION. This step plays the consumer: apply it, reinstall, prove the plugin now
# resolves. A leg whose baseline already satisfies the obligation (a v0.4.0 scaffold
# already carries the pin) must see NO parked file, and that direction is asserted too —
# an obligation raised against a tree that already meets it is a warning people learn to
# ignore.
# ── 5a. the framework security floor ─────────────────────────────────────────────
# tools/framework-floor.json is OWNED, so `update` refreshes it into every existing install
# — a new advisory has to reach trees that already exist. pnpm-workspace.yaml is SEEDED, so
# `update` cannot raise the pin the refreshed floor now demands, and the consumer meets a
# red step 11 carrying the package, the resolved version, the floor and the CVE ids. That is
# correct: a security gate reporting a real vulnerability is not a defect.
#
# It is also, left alone, the permanent death of leg A — the only leg that reaches
# `graduate`'s success branch asserts a GREEN chain, and every floor bump from here on would
# red it for the most ordinary reason there is. The lane plays the consumer and applies the
# documented remedy, exactly as it does for a parked obligation below, then lets the chain
# judge the remedied tree. See scripts/ci/apply-framework-floor.mjs for why this is not a
# dependencyObligations record.
say "framework security floor"
FLOOR_OUT="$(node "$ROOT/scripts/ci/apply-framework-floor.mjs" "$SCAFFOLD")"
echo "$FLOOR_OUT"
FLOOR_RAISED=0
case "$FLOOR_OUT" in *'raised to the security floor'*) FLOOR_RAISED=1 ;; esac

say "dependency obligations"
PARKED="$SCAFFOLD/.harness/pending/dependencies.json"
if [ -f "$PARKED" ]; then
  echo "  parked: $(node -p "require('$PARKED').obligations.map(o=>o.name+'@'+o.catalog).join(', ')")"
  grep -q 'DEPENDENCY OBLIGATION' "$WORK/update.log" ||
    die "an obligation was parked at .harness/pending/dependencies.json but \`update\` never NAMED it in its report — a channel nobody reads is not a channel"

  # Apply it exactly as the report line instructs, then reinstall.
  # Single quotes are REQUIRED below: the ${...} inside are JS template literals, and
  # letting the shell expand them would substitute empty strings. Every value this script
  # needs is passed through process.argv, never interpolated.
  #
  # ARGV IS OFF BY ONE UNDER `-e`. There is no script path to occupy argv[1], so the
  # first user argument IS argv[1] — `[, , a, b]` skips one too many and hands the body
  # `undefined`. Written that way, this block died on `readFileSync(undefined)` the very
  # first time it ran, which was the first time this lane was ever executed rather than
  # reviewed. Held here because the same trap is one character wide and reads correct.
  # shellcheck disable=SC2016
  node -e '
    const { readFileSync, writeFileSync } = require("node:fs")
    const [, scaffold, parked] = process.argv
    if (!scaffold || !parked) {
      throw new Error(`upgrade-lane: expected <scaffold> <parked>, got ${process.argv.slice(1).join(" ") || "nothing"}`)
    }
    const { obligations } = JSON.parse(readFileSync(parked, "utf8"))
    let yaml = readFileSync(scaffold + "/pnpm-workspace.yaml", "utf8")
    const pkg = JSON.parse(readFileSync(scaffold + "/package.json", "utf8"))
    for (const o of obligations) {
      yaml = yaml.replace(/^catalog:\n/m, `catalog:\n  ${o.name}: ${o.catalog}\n`)
      if (o.devDependency !== false) {
        pkg.devDependencies = { ...pkg.devDependencies, [o.name]: "catalog:" }
      }
    }
    writeFileSync(scaffold + "/pnpm-workspace.yaml", yaml)
    writeFileSync(scaffold + "/package.json", JSON.stringify(pkg, null, 2) + "\n")
  ' "$SCAFFOLD" "$PARKED"

else
  echo "  none parked — this baseline's catalog already satisfies every obligation"
fi

# ONE install for both edits above. Gated on either having happened, because a leg whose
# baseline already meets the floor and parks no obligation has nothing to reinstall — and
# asserting the lockfile moved on that leg would demand a change nobody made.
if [ -f "$PARKED" ] || [ "$FLOOR_RAISED" = 1 ]; then
  LOCK_BEFORE="$(lock_digest "$SCAFFOLD/pnpm-lock.yaml")"

  say "pnpm install (after applying the security floor and any obligations)"
  pnpm install --no-frozen-lockfile

  # The assertion that would have caught the original defect: the lockfile MOVED. An
  # obligation that changes no lockfile changed no dependency graph.
  #
  # THIS WAS A `git diff --name-only` AND COULD NEVER HAVE PASSED. The scaffold's baseline
  # commit is taken at §1, BEFORE the lane's first `pnpm install`, so pnpm-lock.yaml is
  # untracked (`??`) for the whole run and a diff over tracked files cannot name it. The
  # obligation applied correctly, pnpm reported `+ eslint-plugin-jsx-a11y 6.10.2`, and the
  # assertion reddened anyway — the first time it was ever executed rather than read. A
  # digest across the install is the claim itself, and it holds whether or not the scaffold
  # ever commits its lockfile.
  [ "$(lock_digest "$SCAFFOLD/pnpm-lock.yaml")" != "$LOCK_BEFORE" ] ||
    die "applying the security floor and the parked obligations did not change pnpm-lock.yaml — the pins resolved to nothing, so the dependency the config needs is still absent"
  echo "  pnpm-lock.yaml regenerated"
fi

# The plugin the 0.4.0 defect was about must RESOLVE on this upgraded install. `resolves`
# and `enforces` are different greens, so the enforcing half is Canary 29 in the selftest;
# this is the half that was silently false for a whole release.
node -e "require.resolve('eslint-plugin-jsx-a11y', { paths: ['$SCAFFOLD'] })" 2>/dev/null ||
  die "eslint-plugin-jsx-a11y does not resolve on the upgraded install — eslint.config.mjs imports it dynamically, so the web a11y floor silently enforces NOTHING and the whole \`lint\` step dies once the dynamic fallback is removed"
echo "  resolves:  eslint-plugin-jsx-a11y"

# And doctor must now be able to reach clean: an unmet obligation is a doctor ERROR (1),
# which §5 below treats as fatal. Applying it above is what keeps that honest — if the
# channel did not work, §5 fails with doctor's own message rather than this one.

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
# DERIVED, not hardcoded — and the derivation is what showed how little this was checking.
# Through 0.5.0 the loop read `for step in wiring secrets`, the two steps 0.3.0 injected. The
# real set at 0.5.0 is SEVEN (tenancy, db-limits, query-shapes, rate-limits, security-headers,
# wiring, secrets): five injections had no assertion in the section whose title says it checks
# them. They were caught indirectly at §5, because `doctor` errors on a missing
# requiredConfigSteps entry — but that is doctor's property, borrowed, and a borrowed property
# is not this section's proof. Reading the same function doctor reads makes the expectation
# grow with the release instead of being remembered.
# 0.6.0: the derivation now carries the TARGET ARRAY, because a configSteps record may name
# `STOP_HOOK_STEPS` instead of the validate chain — and the first `reviewer-verdicts` release
# is the first time that mattered. This lane found that on its first 0.6.0 run: the injection
# had landed correctly in STOP_HOOK_STEPS and this section reported it MISSING, because it
# looked for every required step in `validate --list` output. A lane that reds on a correct
# release is worse than one that stays quiet — it teaches people the lane is wrong.
#
# The Stop chain is read from the installed config, not from the frozen tools/stop.floor.json,
# and the distinction is the whole point of this check: the floor is an OWNED file that
# `update` refreshes, so a Stop step MASKED by the floor's union would still RUN at agent
# time while the consumer's own config silently lacked it. The union is a safety net for a
# weakened config, never a substitute for the injection landing.
EXPECTED_STEPS="$(node -e '
const { requiredConfigSteps, readTemplateMigrations } = await import(
  process.argv[1] + "/installer/lib/migrations.mjs"
)
const steps = requiredConfigSteps(readTemplateMigrations(), process.argv[2])
process.stdout.write(steps.map((s) => `${s.name}:${s.array ?? "VALIDATE_STEPS"}`).join(" "))
' "$ROOT" "$HEAD_VERSION")"
[ -n "$EXPECTED_STEPS" ] ||
  die "no configSteps derived from template/migrations.json at or below $HEAD_VERSION — this lane's whole subject is that injection, and an empty expectation asserts nothing"
node -e '
const { STOP_HOOK_STEPS } = await import(process.argv[1] + "/tools/harness.config.mjs")
process.stdout.write(STOP_HOOK_STEPS.map(([n]) => n).join("\n"))
' "$SCAFFOLD" > "$WORK/stop-steps.txt"
for pair in $EXPECTED_STEPS; do
  step="${pair%%:*}"
  array="${pair##*:}"
  case "$array" in
    STOP_HOOK_STEPS)
      grep -qxF "$step" "$WORK/stop-steps.txt" ||
        die "Stop-chain step \`$step\` is absent from the upgraded install's STOP_HOOK_STEPS — the migrations.json configSteps injection did not reach tools/harness.config.mjs. Note it may still RUN, because tools/stop.floor.json is harness-owned and the Stop hook runs the UNION; that masking is exactly why this asserts the config rather than the behaviour.
$(cat "$WORK/stop-steps.txt")"
      ;;
    *)
      grep -qE "^$step  " "$WORK/steps.txt" ||
        die "step \`$step\` is absent from the upgraded install's chain — the migrations.json configSteps injection did not reach tools/harness.config.mjs.
$(cat "$WORK/steps.txt")"
      ;;
  esac
  echo "  injected:  $step ($array)"
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
# 33-step chain and NOT the 10-step Stop chain. diff-coverage, duplication, i18n,
# test-quality and mobile-perf ramp on the Stop side, so asserting their NOTEs against
# validate.log would fail on a lane that is behaving correctly. Filtering silently would be
# worse than the bug: a gate that quietly leaves the expectation set is a gate nobody is
# checking, which is this repository's whole subject. So it is filtered, printed, and — for
# a met DEADLINE — held to a registered compensating proof in §7e below.
CHAIN_STEPS="$(cut -d' ' -f1 < "$WORK/steps.txt" | tr '\n' ' ')"
in_chain() { case " $CHAIN_STEPS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
narrow() {
  local kept="" dropped=""
  for g in $1; do
    if in_chain "$g"; then kept="$kept $g"; else dropped="$dropped $g"; fi
  done
  [ -z "$dropped" ] || echo "  not in this chain (Stop-chain gates, not asserted here):$dropped" >&2
  # The dropped set is recorded to a file, not a variable: narrow() runs inside $(…), so
  # anything it assigns dies with the subshell — and dropping now has a consequence (§7e).
  printf '%s' "${dropped# }" > "$2"
  printf '%s' "${kept# }"
}
EXPIRED="$(narrow "$EXPIRED" "$WORK/dropped-expired.txt")"
NOTING="$(narrow "$NOTING" "$WORK/dropped-noting.txt")"
DROPPED_EXPIRED="$(cat "$WORK/dropped-expired.txt")"

# ── 7e. a DROPPED expiry must carry a compensating proof, registered and reviewed ─
# narrow() above can drop a MET DEADLINE, not just an advisory NOTE: diff-coverage's
# 0.4.0 surface ramp and reviewer-verdicts' 0.6.0 ramp both live outside the validate
# chain, where this lane never looks. The 0.4.0 header explains why the default leg could
# not execute an expiry; this is the same hole one chain over — a Stop-side (or CI-lane)
# RAMP EXPIRED fires in NO lane, structurally, and until now its only trace was a stderr
# line in a 45-minute log. scripts/ci/stop-side-expiries.json is the reviewed answer:
# every gate whose expiry this lane cannot execute names the unit proof that drives the
# REAL gate to its RAMP EXPIRED exit on a fixture. An unregistered drop dies — silently
# narrowing a deadline out of the expectation set is a check nobody is checking.
STOP_EXPIRIES="$ROOT/scripts/ci/stop-side-expiries.json"
# The stale direction first, and judged per leg: an entry whose gate IS in this leg's
# chain excuses a drop that cannot happen — the lane executes that gate's expiry itself
# (§7a), so the entry's "the lane cannot see this" claim is false. Deliberately NOT
# "must be a Stop step": check-web-e2e.mjs ramps in the consumer's CI lane, outside BOTH
# chains, and an entry for it would be as legitimate as diff-coverage's.
# console.log per key, never a join without a trailing newline: `read` returns nonzero on
# an unterminated final line, so the LAST registered gate would silently skip this check.
node -e '
  const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
  for (const k of Object.keys(m).filter((k) => k !== "//")) console.log(k)
' "$STOP_EXPIRIES" > "$WORK/stop-expiry-gates.txt" ||
  die "scripts/ci/stop-side-expiries.json is missing or unparseable — §7e cannot judge a dropped expiry without the reviewed proof map"
while IFS= read -r g; do
  [ -n "$g" ] || continue
  if in_chain "$g"; then
    die "scripts/ci/stop-side-expiries.json registers \`$g\`, but \`$g\` is in this leg's validate chain — its expiry is executed right here (§7a), so the entry excuses a drop that cannot happen. Remove it."
  fi
done < "$WORK/stop-expiry-gates.txt"
if [ -n "$DROPPED_EXPIRED" ]; then
  say "stop-side expiries — every deadline this lane cannot execute must name its proof"
  for g in $DROPPED_EXPIRED; do
    PROOF="$(node -e '
      const m = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
      const e = m[process.argv[2]]
      if (e === undefined || typeof e.proof !== "string" || typeof e.note !== "string") process.exit(1)
      process.stdout.write(e.proof)
    ' "$STOP_EXPIRIES" "$g")" ||
      die "gate \`$g\` meets its deadline at baseVersion $BASE_AFTER and this lane cannot execute it (not a chain step) — its RAMP EXPIRED branch fires in NO lane. Register the compensating unit proof in scripts/ci/stop-side-expiries.json: { \"$g\": { \"proof\": \"tests/gates/<file>\", \"note\": \"<why the lane cannot execute it>\" } }"
    [ -f "$ROOT/$PROOF" ] ||
      die "scripts/ci/stop-side-expiries.json points \`$g\` at $PROOF, which does not exist — a proof that is not in the tree proves nothing"
    grep -qF 'RAMP EXPIRED' "$ROOT/$PROOF" ||
      die "$PROOF never mentions RAMP EXPIRED — it is registered as the proof that \`$g\`'s expiry actually fires, and a proof that does not execute the expiry branch is decorative coverage"
    echo "  dropped:   $g (deadline met; expiry executed by $PROOF)"
  done
fi

# ── 7a. deadlines MET: the alarm must actually ring, and it must be a red ─────────
# The branch no lane could reach before `--from`: every ramp old enough to expire opens at
# a minVersion at or below the PREVIOUS release, so the default leg's install is already
# past it and rampNote returns false at its first guard.
#
# THE JUDGEMENT MOVED OUT OF THIS FILE (0.5.0), to scripts/lib/ramp-verdict.mjs. It was
# fifteen lines of grep/cut/case here, and it is the single assertion standing between "an
# expiry fired" and "an expiry was supposed to fire and silently did not" — which is the
# exact defect v0.4.0 shipped to fix. A control that important must be runnable by the
# person editing the code it guards, and this one was reachable only through a 45-minute
# job on a throwaway scaffold. tests/gates/ramp-verdict.test.mjs now drives every branch,
# including the neutralised-expiry case that is this release's named canary; the shell
# keeps the parts a shell is good at (running things, reading exit codes).
#
# Both directions are judged by the same call, EXPIRED empty or not: an empty expectation
# has its own consequence (a red chain is then a real regression, not an expiry) and a
# surprise expiry against an empty expectation is the loudest possible classifier
# disagreement.
if [ -n "$EXPIRED" ]; then
  say "deadlines MET — the chain must be RED, and every expiry that fires must be expected"
fi
node "$ROOT/scripts/ci/ramp-verdict.mjs" "$EXPIRED" "$WORK/validate.log" "$VALIDATE_CODE" "$BASE_AFTER" ||
  die "the expiry expectation for baseVersion $BASE_AFTER was not met (see the problem list above and $WORK/validate.log)"
grep -F 'RAMP EXPIRED' "$WORK/validate.log" | sed 's/ was ramped.*//;s/^/    /' | sort -u || true

# ── 7b. a ramped gate RAN, and anything it withheld was announced ────────────────
# THE DIRECTION OF INFERENCE IS REVERSED HERE TOO (0.6.0), for the reason §8 below already
# spells out and this section went on making anyway: **an expected ramp does not imply an
# outstanding finding**, because a gate calls `rampNote` only when it has something to
# withhold — and `rampNote` PRINTS on every armed call, so calling it unconditionally would
# emit a NOTE about nothing on every green run. W2c moved several gates' ramps inside their
# findings condition precisely to stop that.
#
# The old assertion required every gate in the expectation set to have printed a NOTE. On
# this release that reds a CORRECT install: `auth-posture` has findings on an upgraded
# scaffold and announces them, `data-flow` has none because its policy ships planted and the
# stack schema already satisfies it — so it prints OK, which is the honest answer. Reading
# that as "a check shipped disabled" would teach a maintainer the lane is wrong, which is
# worse than the bug it was guarding.
#
# What the section actually protects is unchanged and is now stated directly:
#   1. a gate whose ramp is live must have RUN — silence means it never executed at all;
#   2. anything it WITHHELD must be announced, with a deadline (the check below and §7c).
# The second is the real "shipped disabled" failure, and it is now judged from the run rather
# than predicted from the site list.
for g in $NOTING; do
  if grep -q "^$g: NOTE .*ramp: live from baseVersion" "$WORK/validate.log"; then
    echo "  noting:    $g (withholding findings, announced)"
  elif grep -qE "^$g: (OK|SKIPPED)" "$WORK/validate.log"; then
    echo "  clean:     $g (ramp live, nothing to withhold — no NOTE is the honest answer)"
  elif grep -qF "$g: RAMP EXPIRED" "$WORK/validate.log"; then
    # 0.7.0 taught this loop a third honest outcome: ONE GATE, TWO RAMPS OF DIFFERENT
    # VINTAGES (docs-sync — the 0.6.0 AGENTS gate-list ramp EXPIRING here while the
    # 0.7.0 deferral-ledger ramp is merely live). The expired concern hard-reds the gate
    # before the younger concern produces any line, so demanding OK/NOTE reads a gate
    # that VISIBLY EXECUTED as "did not run". RAMP EXPIRED is execution evidence by
    # definition; the sweep clears the expiry and the post-sweep chain judges the rest.
    echo "  expired-first: $g (an older ramp's expiry preempted the younger ramp's output)"
  else
    die "gate \`$g\` has a live ramp at baseVersion $BASE_AFTER but produced no OK, SKIPPED or NOTE line at all — it did not run. A ramped gate that never executes is a check shipped disabled with nobody told.
$(grep -E "^$g:" "$WORK/validate.log" || echo '    (no output from this gate)')"
  fi
done
# THE SHARP DIRECTION: anything withheld must carry the ramp banner. A gate that prints
# `N finding(s) withheld` without `ramp: live from baseVersion` is suppressing findings with
# no deadline attached to them, which is the exact state the expectation set exists to refuse.
WITHHELD_UNANNOUNCED="$(grep -F 'finding(s) withheld' "$WORK/validate.log" | grep -Fv 'ramp' || true)"
if [ -n "$WITHHELD_UNANNOUNCED" ]; then
  die "gate output withholds findings without naming a ramp — findings suppressed with no deadline against them:
$WITHHELD_UNANNOUNCED"
fi
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
#
# WHICH DIRECTION TO EXPECT IS DECIDED BY THE OBSERVED CHAIN, NOT BY THE PREDICTED EXPIRY
# SET. This branched on `[ -n "$EXPIRED$NOTING" ]` — "the classifier says a deadline is met
# here, therefore graduate must refuse" — and that is the same unsound step §7a made: an
# expected expiry does not imply an outstanding FINDING, because most gates call rampNote
# only when they have something to withhold. Leg D is the case: its one expectation is
# `wiring`, the lane's own obligation step removes the condition `wiring` would have
# reported, the chain comes back green, and graduate correctly opens the door — which this
# assertion then called a defect.
#
# 0.5.0 REPLACED IT WITH `VALIDATE_CODE`, READING GRADUATE'S CONTRACT AS "REFUSES WHILE
# VALIDATE IS RED". THAT IS HALF THE CONTRACT. installer/commands/graduate.mjs refuses on a
# red chain AND, separately, while any ramp NOTE stands — which is the whole point of
# graduating. The half was invisible for exactly one release: 0.5.0 opened no ramp at its own
# minVersion, so on leg A every site was already inert and "green chain" and "no NOTEs"
# coincided. 0.6.0 opens three (auth-posture, the web route registry, the re-opened
# docs-sync gate list), every leg's baseline is below 0.6.0, and the branch below would have
# called a CORRECT refusal a defect on all four.
#
# THE DIRECTION OF INFERENCE IS REVERSED TO FIX IT. Rather than predicting which way graduate
# must go and calling the other one a bug, judge what it DID and require the reason to be
# true — no second copy of graduate's NOTE predicate to drift against, and both failure modes
# still closed: it must never open on a red chain, and it must never refuse for a reason the
# lane's own run cannot corroborate.
#
# 0.9.0 IS THE FIRST RELEASE TO EXECUTE THE UN-SWEPT SUCCESS. A release that injects no
# chain step and opens only quiet-on-a-scaffold ramps hands leg A an EMPTY expectation:
# EXPIRED='' (ramp-verdict already required the green chain at §7a) and every NOTING site
# quiet (§7b read each gate's OK as the honest answer). Nothing stands, so graduate opening
# the door is the CORRECT outcome and the lane passes it; the same corroboration checks
# below keep both refusal shapes fatal on that leg — a refusal naming outstanding findings
# dies on the missing NOTE, and one naming a red chain dies on the lane's own exit 0. A
# door that will not open when nothing blocks it is not an escape with a door.
# ── 7d. THE SWEEP (--sweep) — the shape that opens graduate's door when findings stand ─
# `graduate` has two branches and only one had ever been executed. Through 0.8.0 every
# un-swept leg ended with it REFUSING, because an upgraded install always had ramped
# findings outstanding — that is what a ramp is FOR. The SUCCESS branch is the one that
# moves baseVersion and arms every ramped check at once, and through 0.5.0 nothing anywhere
# ran it. A door nobody has opened is not a door you know opens.
#
# 0.9.0 adds the OTHER way through: a leg whose expectation set is EMPTY — no deadline met,
# no expiry fired, every live ramp quiet — has nothing for a sweep to clear, and graduate
# opening its door un-swept is the correct verdict (§8 judges that direction too). The
# sweep remains the only shape that opens the door while anything STANDS.
#
# So this leg does what the runbook tells a consumer to do, then requires graduate to succeed.
# That makes it a proof of two things at once: that the door opens, and that the sweep in
# docs/runbooks/harness-upgrade.md is SUFFICIENT — a runbook whose steps do not actually clear
# the findings is worse than no runbook, and nothing else here would notice.
if [ "${SWEEP:-0}" = "1" ]; then
  say "sweep — adopt this release's seams, the way the runbook says to"
  # The sweep spans the whole hop, not just HEAD's record: it takes the baseline this lane
  # already proved unmoved (BASE_AFTER, §2) and derives per crossed version — so an expiry
  # release whose own record withholds nothing still sweeps the seams of the versions the
  # upgrade crossed.
  node "$ROOT/scripts/ci/upgrade-sweep.mjs" "$SCAFFOLD" "$ROOT" "$BASE_AFTER" "$HEAD_VERSION" ||
    die "the sweep failed. Its file list is DERIVED per crossed version (seedOnInitOnly + seededSourceFixes between baseVersion $BASE_AFTER and HEAD, through the reviewed SWEEPS table), so an empty or failing sweep means no crossed version withheld anything a consumer must adopt — and a sweep that clears nothing cannot prove graduate opens."
  # COMMIT THE SWEEP, because the runbook does: every gate-integrity NOTE this lane has
  # ever printed ends "commit it along with the rest of the upgrade", and 0.7.0's sweep
  # is the first to adopt a CONFIG-mode file (.gitignore) — the commit-not-dirty rule
  # correctly reds an uncommitted threshold-bearing config, and a lane that models the
  # consumer's edits but not the consumer's commit is modeling half the instruction.
  # The message is CONVENTIONAL and the commit runs the scaffold's own hooks
  # (lefthook + commitlint are live after pnpm install) — the consumer's commit
  # faces them, so the modeled one does too. --no-verify is banned for exactly
  # this reason.
  git -C "$SCAFFOLD" add -A
  git -C "$SCAFFOLD" -c user.email=selftest@localhost -c user.name=selftest commit -qm "chore(harness): adopt the release's seams per the upgrade runbook"
  say "re-validate after the sweep"
  set +e
  (cd "$SCAFFOLD" && node tools/validate.mjs --report-all) > "$WORK/validate.log" 2>&1
  VALIDATE_CODE=$?
  set -e
  tail -25 "$WORK/validate.log"
  [ "$VALIDATE_CODE" -eq 0 ] ||
    die "the chain is RED after the documented sweep (exit $VALIDATE_CODE). Either the runbook is missing a step, or this release ships a seam whose adoption breaks something — both are release defects, and this is the only lane that would find either. See $WORK/validate.log"
  SURVIVING="$(grep -F 'ramp: live from baseVersion' "$WORK/validate.log" || true)"
  if [ -n "$SURVIVING" ]; then
    die "ramp NOTE(s) survive the documented sweep — the runbook does not actually clear what this release ramped:
$SURVIVING"
  fi
fi

say "graduate"
set +e
node "$ROOT/installer/cli.mjs" graduate --dir "$SCAFFOLD" > "$WORK/graduate.log" 2>&1
GRAD_CODE=$?
set -e
# A swept leg exists to execute the SUCCESS branch. If graduate still refuses, the leg has
# proved only what the other three already prove, and must say so rather than pass quietly.
if [ "${SWEEP:-0}" = "1" ] && [ "$GRAD_CODE" -ne 0 ]; then
  die "graduate REFUSED after the documented sweep — this leg's entire purpose is to execute the success branch, so a refusal here means the sweep is incomplete rather than that graduate is wrong:
$(cat "$WORK/graduate.log")"
fi
cat "$WORK/graduate.log"
BASE_FINAL="$(node -p "require('$SCAFFOLD/.harness/manifest.json').baseVersion")"

# graduate's own predicate for "something is still withheld", per LINE and in its own terms:
# a `NOTE —` that mentions a ramp. Two greps rather than one pattern, because the two halves
# are anchored to different things and an ERE trying to span them across arbitrary prose is
# the kind of clever regex that silently stops matching when a message is reworded.
has_ramp_note() { grep -E 'NOTE[[:space:]]*—' "$WORK/validate.log" | grep -qi 'ramp'; }

if [ "$GRAD_CODE" -eq 0 ]; then
  # It opened the door. It may only do that on a green chain with nothing withheld, and the
  # one thing graduation exists to do must have happened.
  [ "$VALIDATE_CODE" -eq 0 ] ||
    die "validate is RED on this install (exit $VALIDATE_CODE) and graduate SUCCEEDED anyway — it would arm every ramped check on a tree that has not swept its findings"
  if has_ramp_note; then
    die "graduate advanced baseVersion while the lane's own validate still printed a ramp NOTE — the findings it was supposed to make turn-fatal were never swept"
  fi
  [ "$BASE_FINAL" = "$HEAD_VERSION" ] ||
    die "graduate exited 0 but baseVersion is $BASE_FINAL, not $HEAD_VERSION — the one thing graduation exists to do did not happen"
  # WHICH SUCCESS THIS WAS is part of the evidence (0.9.0). A swept leg earns the door by
  # clearing what stood; an un-swept leg reaches it only on an empty expectation — the
  # checks above are what make either claim true, and the summary records which one this
  # leg proved.
  if [ "${SWEEP:-0}" = "1" ]; then
    GRAD_SUMMARY="graduate advancing baseVersion $BASE_AFTER -> $BASE_FINAL (the swept door)"
  else
    GRAD_SUMMARY="graduate advancing baseVersion $BASE_AFTER -> $BASE_FINAL (un-swept: empty expectation — expired '${EXPIRED:-none}', every live ramp quiet)"
  fi
else
  # It refused. The refusal must NAME a reason, that reason must be one the lane can see in
  # its own validate output, and it must not have moved anything on the way out.
  grep -qE 'still outstanding|validate is RED' "$WORK/graduate.log" ||
    die "graduate refused, but not for either reason it is allowed to refuse for — the refusal must name the outstanding ramp findings or the red chain. See $WORK/graduate.log"
  if grep -q 'validate is RED' "$WORK/graduate.log"; then
    [ "$VALIDATE_CODE" -ne 0 ] ||
      die "graduate refused saying validate is RED, but the lane's own validate on the same tree exited 0 — two runs of one chain disagreeing is a nondeterministic gate, which is worse than either verdict"
  elif ! has_ramp_note; then
    die "graduate refused for outstanding ramp findings, but the lane's validate printed no ramp NOTE at all — a door that will not open when nothing blocks it is not an escape with a door. See $WORK/graduate.log"
  fi
  [ "$BASE_FINAL" = "$BASE_AFTER" ] || die "a refused graduate still moved baseVersion ($BASE_AFTER -> $BASE_FINAL)"
  GRAD_SUMMARY="graduate refusing (baseVersion held at $BASE_FINAL)"
fi

say "upgrade-lane: OK — $PREV_TAG -> v$HEAD_VERSION on $STEP_COUNT steps, doctor $DOCTOR_CODE, validate exit $VALIDATE_CODE (expired: ${EXPIRED:-none}; noting: ${NOTING:-none}; inert: $INERT), $GRAD_SUMMARY"
