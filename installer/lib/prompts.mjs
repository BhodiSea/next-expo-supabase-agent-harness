// Interactive prompting for placeholder answers; --yes takes defaults,
// --set VAR=value overrides. Zero-dep: node:readline/promises.
import readline from 'node:readline/promises'
import { PLACEHOLDERS } from './placeholders.mjs'

export async function collectAnswers({ yes, sets, ctx }) {
  const answers = {}
  ctx.answers = answers
  for (const [name, value] of Object.entries(sets)) answers[name] = value

  let rl = null
  for (const [name, spec] of Object.entries(PLACEHOLDERS)) {
    if (name in answers) continue
    const def = spec.default(ctx)
    if (yes) {
      answers[name] = def
      continue
    }
    rl ??= readline.createInterface({ input: process.stdin, output: process.stdout })
    // Re-prompt on invalid input instead of baking a bad value into committed
    // identity/CSP surfaces.
    for (;;) {
      const reply = await rl.question(`${spec.prompt} [${def}]: `)
      const value = reply.trim() === '' ? def : reply.trim()
      const problem = spec.validate?.(value) ?? null
      if (problem === null) {
        answers[name] = value
        break
      }
      console.error(`  ${name} ${problem}`)
    }
  }
  rl?.close()

  // Non-interactive values (--set, --yes defaults, --force carry-over) get the
  // same validation — fail loud before a single file is written.
  const problems = Object.entries(PLACEHOLDERS)
    .map(([name, spec]) => {
      const problem = spec.validate?.(String(answers[name] ?? '')) ?? null
      return problem === null ? null : `${name} ${problem} (got: ${JSON.stringify(answers[name])})`
    })
    .filter(Boolean)
  if (problems.length > 0) {
    throw new Error(`invalid placeholder value(s):\n  ${problems.join('\n  ')}`)
  }
  return answers
}

export function parseSets(setArgs) {
  const sets = {}
  for (const s of setArgs ?? []) {
    const eq = s.indexOf('=')
    if (eq === -1) throw new Error(`--set expects VAR=value, got: ${s}`)
    const name = s.slice(0, eq)
    // An unknown key would render nothing and leave {{TOKENS}} in the scaffold
    // — reject it here instead of shipping placeholder residue.
    if (!(name in PLACEHOLDERS)) {
      throw new Error(`--set ${name}: unknown placeholder (known: ${Object.keys(PLACEHOLDERS).join(' ')})`)
    }
    sets[name] = s.slice(eq + 1)
  }
  return sets
}
