// home(class) (template/base/tools/lib/homes.mjs, 2.1.0, #186): where one copy of a class of
// equal bodies can live, judged by the rule files the gates already enforce. Each fixture is
// one class of two or more equal bodies; the case names the home it must get and why:
// IMPORT to the member with the most importers that every other member may already import,
// MODULE inside one workspace, LIFT to a new packages/shared package where that is legal
// for every member, and NONE where it is not (web and mobile, a domain file, a platform leaf).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { home, loadForbidden } from '../../template/base/tools/lib/homes.mjs'
import { buildImporters } from '../../template/base/tools/lib/importers.mjs'
import { extractTree } from '../../template/base/tools/lib/shapes.mjs'
import { readCensus } from '../../template/base/tools/lib/workspace-tiers.mjs'
import { BODY, inTree, pkg, treeTest, ts } from './helpers/single-home.mjs'

// Read by path, not imported: the rule file is the scaffold's, not the factory's.
const DEPCRUISE = readFileSync(join(fileURLToPath(new URL('../../template/base/', import.meta.url)), 'dependency-cruiser.cjs'), 'utf8')

/**
 * home() of the class made of the one callable in each of `paths`, over the current tree.
 * @param {string[]} paths @param {any} [parser]
 */
function homeOf(paths, parser = ts) {
  const { callables } = extractTree(parser)
  const members = paths.map((p) => callables.find((c) => c.path === p))
  assert.ok(members.every(Boolean), `every fixture path holds a callable: ${paths.join(', ')}`)
  assert.equal(new Set(members.map((m) => m.alpha)).size, 1, 'the fixture is one class')
  const ctx = { importers: buildImporters(), census: readCensus(), forbidden: loadForbidden() }
  const litEqual = new Set(members.map((m) => m.lit)).size === 1
  const where = home({ lang: members[0].lang, members, litEqual }, ctx)
  return { kind: where.kind, target: where.target?.path ?? null }
}

const CROSS = {
  'packages/a/package.json': pkg('@app/a'),
  'packages/a/src/index.ts': "export { eventOf } from './m'\n",
  'packages/a/src/m.ts': BODY('eventOf'),
  'packages/a/src/use.ts': "import { eventOf } from './m'\nexport const u = eventOf\n",
  'packages/b/package.json': pkg('@app/b', ['@app/a']),
  'packages/b/src/index.ts': "export { eventFor } from './n'\n",
  'packages/b/src/n.ts': BODY('eventFor'),
  'packages/b/src/u1.ts': "import { eventFor } from './n'\nexport const u = eventFor\n",
  'packages/b/src/u2.ts': "import { eventFor } from './n'\nexport const u = eventFor\n",
}

treeTest('homes: IMPORT across workspaces goes to the copy every other member already depends on', () => {
  // @app/b's copy has more importers, but @app/a declares no dependency on @app/b, so it is
  // passed over for @app/a's, which @app/b reaches through its runtime dependency and the
  // `.` subpath of the exports map.
  inTree(CROSS, () => {
    assert.deepEqual(homeOf(['packages/a/src/m.ts', 'packages/b/src/n.ts']), {
      kind: 'import',
      target: 'packages/a/src/m.ts',
    })
  })
})

treeTest('homes: no IMPORT when the literals differ, so two workspaces with a legal lift get LIFT', () => {
  inTree({ ...CROSS, 'packages/b/src/n.ts': BODY('eventFor', 'tasks.created') }, () => {
    assert.deepEqual(homeOf(['packages/a/src/m.ts', 'packages/b/src/n.ts']), { kind: 'lift', target: null })
  })
})

treeTest('homes: IMPORT inside one workspace goes to the member with the most importers; a tie breaks by path', () => {
  const tree = (yImporters) => ({
    'packages/c/package.json': pkg('@app/c'),
    'packages/c/src/x.ts': BODY('first'),
    'packages/c/src/y.ts': BODY('second'),
    'packages/c/src/u0.ts': "import { first } from './x'\nexport const u = first\n",
    ...Object.fromEntries(
      Array.from({ length: yImporters }, (_, i) => [
        `packages/c/src/v${String(i)}.ts`,
        "import { second } from './y'\nexport const v = second\n",
      ]),
    ),
  })
  inTree(tree(2), () => {
    assert.deepEqual(homeOf(['packages/c/src/x.ts', 'packages/c/src/y.ts']), {
      kind: 'import',
      target: 'packages/c/src/y.ts',
    })
  })
  inTree(tree(1), () => {
    assert.deepEqual(homeOf(['packages/c/src/x.ts', 'packages/c/src/y.ts']), {
      kind: 'import',
      target: 'packages/c/src/x.ts',
    })
  })
})

treeTest('homes: the anatomy laws pick the target: a domain file may not import data/, so the domain copy is it', () => {
  inTree(
    {
      'packages/verticals/notes/package.json': pkg('@app/notes'),
      'packages/verticals/notes/src/domain/event.ts': BODY('eventOf'),
      'packages/verticals/notes/src/data/event.ts': BODY('eventFor'),
      'packages/verticals/notes/src/data/u1.ts': "import { eventFor } from './event'\nexport const u = eventFor\n",
      'packages/verticals/notes/src/data/u2.ts': "import { eventFor } from './event'\nexport const u = eventFor\n",
    },
    () => {
      assert.deepEqual(
        homeOf(['packages/verticals/notes/src/data/event.ts', 'packages/verticals/notes/src/domain/event.ts']),
        { kind: 'import', target: 'packages/verticals/notes/src/domain/event.ts' },
      )
    },
  )
})

treeTest('homes: MODULE inside one workspace when no member is exported, or the literals differ', () => {
  const tree = {
    'packages/c/package.json': pkg('@app/c'),
    'packages/c/src/x.ts': BODY('first').replace('export ', ''),
    'packages/c/src/y.ts': BODY('second').replace('export ', ''),
    'packages/c/src/p.ts': BODY('third'),
    'packages/c/src/q.ts': BODY('fourth', 'tasks.created'),
  }
  inTree(tree, () => {
    assert.deepEqual(homeOf(['packages/c/src/x.ts', 'packages/c/src/y.ts']), { kind: 'module', target: null })
    assert.deepEqual(homeOf(['packages/c/src/p.ts', 'packages/c/src/q.ts']), { kind: 'module', target: null })
  })
})

const VERTICALS = {
  '.dependency-cruiser.cjs': DEPCRUISE,
  'packages/verticals/notes/package.json': pkg('@app/notes'),
  'packages/verticals/notes/src/index.ts': "export { eventOf } from './data/event'\n",
  'packages/verticals/notes/src/data/event.ts': BODY('eventOf'),
  'packages/verticals/tasks/package.json': pkg('@app/tasks', ['@app/notes']),
  'packages/verticals/tasks/src/data/event.ts': BODY('eventFor'),
}

treeTest('homes: LIFT for two verticals: the vertical wall stops IMPORT even with the dependency declared', () => {
  inTree(VERTICALS, () => {
    assert.deepEqual(
      homeOf(['packages/verticals/notes/src/data/event.ts', 'packages/verticals/tasks/src/data/event.ts']),
      { kind: 'lift', target: null },
    )
  })
})

treeTest('homes: NONE when a member is a domain file: domain purity admits no packages/shared import', () => {
  inTree(
    {
      ...VERTICALS,
      'packages/verticals/notes/src/domain/codec.ts': BODY('encode'),
      'packages/verticals/tasks/src/domain/codec.ts': BODY('decode'),
    },
    () => {
      assert.deepEqual(
        homeOf(['packages/verticals/notes/src/domain/codec.ts', 'packages/verticals/tasks/src/domain/codec.ts']),
        { kind: 'none', target: null },
      )
    },
  )
})

treeTest("homes: no LIFT with a platform member: the architecture step's kernel-only rule forbids it", () => {
  const tree = {
    'packages/platform/errors/package.json': pkg('@app/errors'),
    'packages/platform/errors/src/event.ts': BODY('eventOf').replace('export ', ''),
    'packages/verticals/notes/package.json': pkg('@app/notes'),
    'packages/verticals/notes/src/data/event.ts': BODY('eventFor').replace('export ', ''),
  }
  const members = ['packages/platform/errors/src/event.ts', 'packages/verticals/notes/src/data/event.ts']
  inTree({ ...tree, '.dependency-cruiser.cjs': DEPCRUISE }, () => {
    assert.deepEqual(homeOf(members), { kind: 'none', target: null })
  })
  // The verdict is the rule file's: with no .dependency-cruiser.cjs the same class lifts.
  inTree(tree, () => assert.deepEqual(homeOf(members), { kind: 'lift', target: null }))
})

treeTest('homes: NONE for web and mobile, until a reviewed census entry admits the shared package', () => {
  const tree = {
    'apps/web/package.json': pkg('web'),
    'apps/web/lib/event.ts': BODY('eventOf'),
    'apps/mobile/package.json': pkg('mobile'),
    'apps/mobile/src/event.ts': BODY('eventFor'),
  }
  const members = ['apps/web/lib/event.ts', 'apps/mobile/src/event.ts']
  inTree(tree, () => assert.deepEqual(homeOf(members), { kind: 'none', target: null }))
  inTree({ ...tree, 'tools/exports-walls.json': '{"sanctioned":[{"package":"@app/concept"}]}' }, () =>
    assert.deepEqual(homeOf(members), { kind: 'lift', target: null }),
  )
})

const DENY = (schema) => `CREATE FUNCTION ${schema}.deny_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $deny$
BEGIN
  RAISE EXCEPTION '${schema}.events is append-only (% on % refused)', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$deny$;
`

test('homes: a SQL class is MODULE, one function in schema private, with no parser needed', () => {
  inTree(
    {
      'supabase/migrations/20260202000000_audit.sql': DENY('audit'),
      'supabase/migrations/20260816000000_auth_event_trail.sql': DENY('auth_trail'),
    },
    () => {
      assert.deepEqual(
        homeOf(
          ['supabase/migrations/20260202000000_audit.sql', 'supabase/migrations/20260816000000_auth_event_trail.sql'],
          null,
        ),
        { kind: 'module', target: null },
      )
    },
  )
})
