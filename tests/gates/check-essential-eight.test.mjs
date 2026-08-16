// Can-fail proofs for the ASD Essential Eight conformance register's closures. The
// judgements live in template/base/tools/lib/essential-eight.mjs and are tested here as
// pure functions; both consumers (the `docs-sync` second script and the factory-side
// evidence check) share them, so a hole here is a hole in both.
//
// WHAT THESE PROOFS ARE ACTUALLY ABOUT. Every other gate in this harness judges CODE. This
// one judges a CLAIM: 149 rows stating how a generated application stands against Maturity
// Level Three. A compliance register is worth exactly as much as the trust in its grades,
// and the cheapest way to fake conformance is not to weaken a control — it is to regrade a
// row. So the injections below are the regrade attempts: a control nobody runs, an
// artefact counted twice, a top-tier evidence claim with no injection behind it, an
// unbuilt row with nobody owning it, and an empty register reading as a clean bill of
// health.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
	canaryProblems,
	censusProblems,
	negativeProofProblems,
	rowProblems,
	sharedClauseProblems,
	summarise,
	supersessionProblems,
} from "../../template/base/tools/lib/essential-eight.mjs";
import {
	STOP_HOOK_STEPS,
	VALIDATE_STEPS,
} from "../../template/base/tools/harness.config.mjs";
import { liveControls } from "../../template/base/tools/lib/live-controls.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SHIPPED = JSON.parse(
	readFileSync(join(ROOT, "template/base/tools/essential-eight.json"), "utf8"),
);
const clone = () => JSON.parse(JSON.stringify(SHIPPED));

/**
 * What actually runs, DERIVED — the same `liveControls()` call the gate itself makes,
 * over the shipped chain and the shipped workflows.
 *
 * This was a hand-written set of six names for one release, and it drifted the first
 * time a row named a control the list had not been told about: W3 graded MFA-10 against
 * `auth-posture`, a chain step that has shipped since 0.6.0, and the clean-case test
 * reported it as "not a LIVE control" — a red on the proof rather than on the register.
 * A fixture that mirrors production by hand is a fixture that eventually asserts the
 * mirror instead of the thing.
 */
const CONTROLS = liveControls({
	steps: [...VALIDATE_STEPS, ...STOP_HOOK_STEPS].map(([name]) => name),
	workflowDir: join(ROOT, "template/base/github/workflows"),
});

// ---- the shipped register is the clean case -----------------------------------------
test("the SHIPPED register passes every closure — the clean case is a real tree, not a fixture", () => {
	const reg = clone();
	assert.deepEqual(censusProblems(reg), []);
	assert.deepEqual(supersessionProblems(reg), []);
	assert.deepEqual(rowProblems(reg, CONTROLS), []);
	assert.deepEqual(sharedClauseProblems(reg), []);
});

test("the shipped register carries all 149 ML3 requirements, per ASD Appendix C", () => {
	assert.equal(SHIPPED.requirements.length, 149);
	assert.equal(SHIPPED.expectedCounts.total, 149);
});

// ---- census -------------------------------------------------------------------------
test("a DELETED row reds naming its strategy and both counts", () => {
	const reg = clone();
	reg.requirements = reg.requirements.filter((r) => r.id !== "RB-11");
	const problems = censusProblems(reg);
	assert.ok(
		problems.some((p) => /Regular backups.*10 row\(s\), expected 11/.test(p)),
	);
});

test("the 152-vs-149 trap: the three superseded requirements are RECORDED, not deleted", () => {
	assert.equal(SHIPPED.supersededAtML3.length, 3);
	const reg = clone();
	reg.supersededAtML3 = [];
	const problems = supersessionProblems(reg);
	assert.ok(problems.some((p) => /supersedes exactly three/.test(p)));
});

test("a superseded requirement that ALSO appears as a live row reds — it must not be counted", () => {
	const reg = clone();
	reg.requirements[0] = {
		...reg.requirements[0],
		text: reg.supersededAtML3[0].text,
	};
	assert.ok(
		supersessionProblems(reg).some((p) => /recorded, never counted/.test(p)),
	);
});

// ---- live controls ------------------------------------------------------------------
test("an `effective` row naming a control nothing runs reds — a control nobody runs is not a control", () => {
	const reg = clone();
	reg.requirements.find((r) => r.id === "RAP-05").control = "no-such-gate";
	assert.ok(
		rowProblems(reg, CONTROLS).some((p) => /is not a LIVE control/.test(p)),
	);
});

test("a CONDITIONAL control must disclose which kind it is — existing and running are different claims", () => {
	const reg = clone();
	const row = reg.requirements.find((r) => r.id === "PA-02");
	row.note = "a note that hides the conditionality";
	const problems = rowProblems(reg, CONTROLS);
	assert.ok(
		problems.some((p) => /CONDITIONAL.*path-filtered.*schedule-gated/s.test(p)),
	);
});

// ---- the grades themselves ----------------------------------------------------------
test("`alternate-control` without assessorMayRefuse reds — it is never pre-earned by a generator", () => {
	const reg = clone();
	delete reg.requirements.find((r) => r.id === "AC-06").assessorMayRefuse;
	assert.ok(
		rowProblems(reg, CONTROLS).some((p) => /assessorMayRefuse: true/.test(p)),
	);
});

test("`not-implemented` with no obligation reds — the register cannot hide a gap", () => {
	// RB-03 since 1.0.0: the deploy-record channel regraded RB-02 (the old fixture) positive.
	const reg = clone();
	delete reg.requirements.find((r) => r.id === "RB-03").obligation;
	assert.ok(
		rowProblems(reg, CONTROLS).some((p) => /must name an 'obligation'/.test(p)),
	);
});

test("`not-applicable` with no negative proof reds — silence is not a proof", () => {
	const reg = clone();
	reg.requirements.find((r) => r.id === "MACRO-01").negativeProof = "";
	assert.ok(
		rowProblems(reg, CONTROLS).some((p) => /Silence is not a proof/.test(p)),
	);
});

test("an organisation-boundary row may not carry an outcome, and must name an owner", () => {
	const reg = clone();
	const row = reg.requirements.find((r) => r.boundary === "organisation");
	row.outcome = "effective";
	assert.ok(rowProblems(reg, CONTROLS).some((p) => /must be null/.test(p)));

	const reg2 = clone();
	delete reg2.requirements.find((r) => r.boundary === "organisation").owner;
	assert.ok(
		rowProblems(reg2, CONTROLS).some((p) => /must name an 'owner'/.test(p)),
	);
});

test("an unbuilt requirement cannot claim the top evidence tier", () => {
	// RB-03 since 1.0.0, for the same reason as the obligation fixture above.
	const reg = clone();
	reg.requirements.find((r) => r.id === "RB-03").evidenceTier =
		"simulated-activity";
	assert.ok(
		rowProblems(reg, CONTROLS).some((p) =>
			/cannot be evidenced by simulated activity/.test(p),
		),
	);
});

test("reachability is FROZEN research, not a grade — an invalid value reds", () => {
	const reg = clone();
	reg.requirements[0].reachability = "effective";
	assert.ok(
		rowProblems(reg, CONTROLS).some((p) => /reachability.*FROZEN/s.test(p)),
	);
});

// ---- shared clauses: the anti-inflation closure --------------------------------------
test("one artefact, one claim — a second shared-clause instance claiming a control reds", () => {
	const reg = clone();
	const row = reg.requirements.find((r) => r.id === "AC-12");
	row.outcome = "effective";
	row.control = "tenancy";
	row.proof = "supabase/tests/audit_immutability.test.sql";
	delete row.obligation;
	assert.ok(
		sharedClauseProblems(reg).some((p) =>
			/counting it twice is compliance inflation/.test(p),
		),
	);
});

test("shared-clause instances may DIFFER in outcome — identical text, different subject stream", () => {
	// The load-bearing design decision. SPINE-LOG-PROTECT reads identically under four
	// strategies, but its subject is each strategy's own log stream: the audit trail
	// genuinely protects privileged-access events (RAP-22, effective) and genuinely has no
	// application-control events to protect (AC-12, not-implemented). Forcing equal grades
	// would inflate three rows or deflate one, so divergence must NOT red.
	const spine = SHIPPED.sharedClauses.find((c) => c.id === "SPINE-LOG-PROTECT");
	const outcomes = spine.appearsIn.map(
		(id) => SHIPPED.requirements.find((r) => r.id === id).outcome,
	);
	assert.ok(
		new Set(outcomes).size > 1,
		"the shipped register must exercise the divergent case",
	);
	assert.deepEqual(sharedClauseProblems(clone()), []);
});

test("the shared clause link is closed BOTH ways", () => {
	const reg = clone();
	delete reg.requirements.find((r) => r.id === "RAP-22").sharedClause;
	assert.ok(
		sharedClauseProblems(reg).some((p) => /does not reference it back/.test(p)),
	);
});

test("a claimant that is not one of its own instances reds", () => {
	const reg = clone();
	reg.sharedClauses.find(
		(c) => c.id === "SPINE-LOG-PROTECT",
	).artefactClaimedBy = "RB-01";
	assert.ok(
		sharedClauseProblems(reg).some((p) =>
			/is not among its own instances/.test(p),
		),
	);
});

// ---- the machine-checked negative proof ----------------------------------------------
test("enabling [storage] reds — eleven macro grades rest on there being no document surface", () => {
	const problems = negativeProofProblems({
		configToml: "[storage]\nenabled = true\n",
		uploadRoutes: [],
	});
	assert.ok(problems.some((p) => /\[storage\] is ENABLED/.test(p)));
});

test("an absent [storage] setting is not a proof either", () => {
	assert.ok(
		negativeProofProblems({
			configToml: "[auth]\nenabled = true\n",
			uploadRoutes: [],
		}).some((p) => /an absent setting is not a proof/.test(p)),
	);
});

test("a discovered upload surface reds naming the file", () => {
	const problems = negativeProofProblems({
		configToml: "[storage]\nenabled = false\n",
		uploadRoutes: ["apps/web/app/api/upload/route.ts"],
	});
	assert.ok(
		problems.some((p) => /apps\/web\/app\/api\/upload\/route\.ts/.test(p)),
	);
});

test("the upload scan covers BOTH surfaces — a mobile picker breaks the macro grades too", () => {
	// The tier-coverage control caught this as a one-surface scan on its first run, and the
	// honest fix was to widen the scan rather than declare a tier: eleven macro rows are
	// graded not-applicable because no document-parsing surface exists, and an
	// expo-document-picker upload on the mobile half falsifies that exactly as a web route
	// handler does. Scanning one surface would have made the negative proof true of half the
	// product and asserted of all of it.
	const problems = negativeProofProblems({
		configToml: "[storage]\nenabled = false\n",
		uploadRoutes: ["apps/mobile/src/features/attach/upload.ts"],
	});
	assert.ok(
		problems.some((p) =>
			/apps\/mobile\/src\/features\/attach\/upload\.ts/.test(p),
		),
	);
});

// ---- the factory-side evidence closure -----------------------------------------------
//
// 0.10.0 widened this from the five simulated-activity rows to all ELEVEN positive claims.
// The old scope let a row grade itself `effective` and escape the closure entirely by
// claiming a lower evidence tier — the tier records how GOOD the evidence is, and this
// closure asks whether there is any. Every test below is a way that escape reopens.

/** The real registry, both halves — the union the widened closure resolves against. */
const realKeys = () => {
	const c = JSON.parse(
		readFileSync(join(ROOT, "tests/canary/injections.json"), "utf8"),
	);
	return new Set([...Object.keys(c.steps), ...Object.keys(c.lanes)]);
};

test("a simulated-activity claim naming an unregistered canary reds", () => {
	const reg = clone();
	reg.requirements.find((r) => r.id === "RAP-22").canary = "no-such-step";
	assert.ok(
		canaryProblems(reg, new Set(["tenancy"])).some((p) =>
			/has no entry in/.test(p),
		),
	);
});

test("a simulated-activity claim with NO canary reds — a gate that cannot go red is decoration", () => {
	const reg = clone();
	delete reg.requirements.find((r) => r.id === "RAP-22").canary;
	assert.ok(
		canaryProblems(reg, new Set(["tenancy"])).some((p) =>
			/must name the 'canary'/.test(p),
		),
	);
});

test("WIDENED (0.10.0): an `effective` row with no canary reds even at a LOWER tier", () => {
	// The escape the old scope left open, and the reason the widening was worth a release:
	// grade yourself effective, claim system-generated-artefact, name no proof, stay green.
	const reg = clone();
	const row = reg.requirements.find((r) => r.id === "PA-02");
	assert.equal(row.outcome, "effective");
	assert.equal(
		row.evidenceTier,
		"system-generated-artefact",
		"not the top tier — that is the point",
	);
	delete row.canary;
	const problems = canaryProblems(reg, realKeys());
	assert.equal(problems.length, 1);
	assert.match(
		problems[0],
		/is a POSITIVE claim, so it must name the 'canary'/,
	);
	assert.match(problems[0], /indistinguishable from one that cannot/);
});

test("WIDENED: an `alternate-control` row is held to the same bar as an `effective` one", () => {
	const reg = clone();
	delete reg.requirements.find((r) => r.id === "PA-01").canary;
	assert.ok(
		canaryProblems(reg, realKeys()).some((p) =>
			/PA-01.*POSITIVE claim/s.test(p),
		),
	);
});

test("ANTI-INFLATION: citing another gate’s real proof reds — the field is not a duplicate of `control`", () => {
	// Without this arm the widening would be cosmetic: any row could name `tenancy`, the id
	// would resolve, and the closure would report a proven claim about a gate it never ran.
	const reg = clone();
	reg.requirements.find((r) => r.id === "MFA-10").canary = "tenancy";
	const problems = canaryProblems(reg, realKeys());
	assert.equal(problems.length, 1);
	assert.match(
		problems[0],
		/does not name the control this row claims \('auth-posture'\)/,
	);
});

test("a row that grades NOTHING may not cite a red-proof", () => {
	// The inverse direction. A not-implemented row carrying a canary reads as evidence for a
	// claim nobody made — and MFA-09 is exactly the row a reader would expect one on.
	const reg = clone();
	reg.requirements.find((r) => r.id === "MFA-01").canary = "auth-posture";
	assert.ok(
		canaryProblems(reg, realKeys()).some((p) => /claims no control/.test(p)),
	);
});

test("LANE-BACKED claims resolve: three rows cite a CI job, not a chain step", () => {
	// steps{} alone was the 0.9.9 scope, and under it PA-02/03/05 and PA-01 could not have
	// named a proof at all — the shape in which a widened closure gets weakened to fit.
	const stepsOnly = new Set(
		Object.keys(
			JSON.parse(
				readFileSync(join(ROOT, "tests/canary/injections.json"), "utf8"),
			).steps,
		),
	);
	const problems = canaryProblems(clone(), stepsOnly);
	assert.ok(
		problems.length >= 4,
		"the narrow set must fail the lane-backed rows",
	);
	for (const id of ["PA-01", "PA-02", "PA-03", "PA-05"]) {
		assert.ok(
			problems.some((p) => p.includes(id)),
			`${id} must red against steps{} alone`,
		);
	}
	// ...and the union clears every one of them.
	assert.deepEqual(canaryProblems(clone(), realKeys()), []);
});

// ---- the NEGATIVE half of closure 4 (0.11.0) -----------------------------------------
// 0.10.0 recorded the remainder as "26 more rows" discharged by "supply the canary, or
// regrade the row down". Both halves were wrong: the remainder is 28, and every one of them
// is `not-applicable`, so supplying a canary REDS via the claims-no-control branch. What such
// a row owes is the opposite artefact — a proof the absence would be NOTICED if it ended.

test("a not-applicable row above the documentation floor must name a negativeCanary", () => {
	const reg = clone();
	const row = reg.requirements.find((r) => r.id === "MACRO-01");
	assert.equal(
		row.evidenceTier,
		"system-generated-artefact",
		"fixture assumes an above-floor row",
	);
	delete row.negativeCanary;
	const problems = canaryProblems(reg, realKeys());
	assert.equal(problems.length, 1, problems.join("\n"));
	assert.match(problems[0], /names no 'negativeCanary'/);
	assert.match(problems[0], /regrade the row to 'documentation'/);
});

test("a negativeCanary that resolves nowhere reds — the absence rests on an unregistered proof", () => {
	const reg = clone();
	reg.requirements.find((r) => r.id === "MACRO-01").negativeCanary =
		"no-such-proof";
	assert.ok(
		canaryProblems(reg, realKeys()).some((p) =>
			/has no entry in tests\/canary\/injections\.json/.test(p),
		),
	);
});

test("THE FLOOR IS A REAL FLOOR: a documentation-tier not-applicable row needs no negativeCanary", () => {
	// The demand attaches exactly where the row claims a machine-generated artefact. UAH-02 is
	// one of the four regraded DOWN in this release: web-browser hardening rests on "no
	// browser-fleet component", which nothing machine-checks, so the honest tier is documentation.
	const reg = clone();
	const row = reg.requirements.find((r) => r.id === "UAH-02");
	assert.equal(row.evidenceTier, "documentation");
	assert.equal(row.negativeCanary, undefined);
	assert.deepEqual(canaryProblems(reg, realKeys()), []);
});

test("the negative field cannot be attached to a row that claims no absence", () => {
	const reg = clone();
	reg.requirements.find((r) => r.id === "MFA-15").negativeCanary = "docs-sync";
	assert.ok(
		canaryProblems(reg, realKeys()).some((p) => /claims no absence/.test(p)),
	);
});

test("BYPASS GUARD: a not-applicable row still may not name a positive `canary`", () => {
	// The new field must not become an escape from the old arm — a row cannot buy its way out
	// of "claims no control" by supplying both.
	const reg = clone();
	const row = reg.requirements.find((r) => r.id === "MACRO-01");
	row.canary = "docs-sync";
	assert.ok(
		canaryProblems(reg, realKeys()).some((p) => /claims no control/.test(p)),
	);
});

test("every shipped not-applicable row above the floor resolves against the real registry", () => {
	// The negative twin of the positive closure below. Pins the subject set so a silent shrink
	// (a regrade sweep that empties the population) cannot make this pass vacuously.
	const reg = clone();
	const above = reg.requirements.filter(
		(r) =>
			r.outcome === "not-applicable" &&
			(r.evidenceTier === "system-generated-artefact" ||
				r.evidenceTier === "simulated-activity"),
	);
	assert.equal(
		above.length,
		24,
		"the closure is worthless if its subject set silently shrinks",
	);
	assert.deepEqual(canaryProblems(reg, realKeys()), []);
});

test("every shipped POSITIVE claim resolves against the real canary registry", () => {
	const reg = clone();
	const positive = reg.requirements.filter(
		(r) => r.outcome === "effective" || r.outcome === "alternate-control",
	);
	// 21 since 1.0.0: the privilege-lifecycle discharge regraded RAP-03/RAP-13 to
	// effective and RAP-02 to alternate-control (rls-isolation canary), the auth-event
	// trail regraded MFA-15 (auth-posture canary), the vendor-support register
	// regraded PA-11 and POS-16 (version-sync canary), and the deploy-record channel
	// regraded PA-06/PA-07/PA-10 (patch-window lane) and RB-02 (restore-manifest lane).
	assert.equal(
		positive.length,
		21,
		"the closure is worthless if its subject set silently shrinks",
	);
	assert.deepEqual(canaryProblems(reg, realKeys()), []);
});

// ---- the summary the published figures derive from ------------------------------------
test("summarise() partitions every row exactly once — published figures are DERIVED", () => {
	const s = summarise(SHIPPED);
	assert.equal(
		s.effective +
			s.alternateControl +
			s.notImplemented +
			s.notApplicable +
			s.organisation,
		s.total,
	);
	assert.equal(s.total, 149);
	// Every not-implemented row names an obligation, so the obligation set cannot be empty
	// while gaps exist — the closure that stops the register hiding one.
	assert.ok(s.notImplemented === 0 || s.obligations.length > 0);
});
