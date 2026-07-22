// Retrofit merge for .gitignore: theirs verbatim, harness-required patterns
// appended (dedup on trimmed line) under one marker. The harness needs its
// ignore lines active (e.g. .dev-auth/, .harness stamps, target/) — a sibling
// file would be inert, and clobbering a project's ignore rules is destructive.
const MARKER = '# --- next-expo-supabase-agent-harness ---'

export function mergeGitignore(existingText, incomingText) {
  const theirLines = new Set(existingText.split('\n').map((l) => l.trim()))
  const missing = incomingText
    .split('\n')
    .filter((l) => {
      const t = l.trim()
      return t !== '' && !t.startsWith('#') && !theirLines.has(t)
    })
  if (missing.length === 0) return { merged: existingText, added: [] }
  const base = existingText.endsWith('\n') ? existingText : `${existingText}\n`
  return { merged: `${base}\n${MARKER}\n${missing.join('\n')}\n`, added: missing }
}
