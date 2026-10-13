/**
 * End-to-end test for dsh-android-control.
 *
 * Loads the plugin with a stub context and drives every tool against the real
 * phone. No LLM is involved, so this costs nothing to run.
 *
 * The important part is `validate()`: calling `execute()` directly — as an
 * earlier version of this test did — bypasses the registry's output check, and
 * that blind spot let a real bug through (a tool returned a field its
 * `output.schema` did not declare, so every real call failed validation while
 * this test stayed green). Every returned value is now checked against its own
 * schema with the same strictness the registry applies.
 */

import { apply } from '../index.js'

// ── a minimal JSON Schema checker, enough for the shapes used here ───────────
function validate(schema, value, path = '$') {
  const errs = []
  const type = schema.type
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  const want = type === 'integer' ? 'number' : type

  if (want && actual !== want) {
    errs.push(`${path}: expected ${type}, got ${actual}`)
    return errs
  }
  if (type === 'integer' && !Number.isInteger(value)) errs.push(`${path}: expected integer, got ${value}`)

  if (type === 'object') {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errs.push(`${path}.${key}: required but missing`)
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties ?? {}))) errs.push(`${path}.${key}: returned but not declared (additionalProperties:false)`)
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in value) errs.push(...validate(sub, value[key], `${path}.${key}`))
    }
  }
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${value} not in enum`)
  return errs
}

// ── stub context ────────────────────────────────────────────────────────────
const tools = {}
let savedImage = null
const ctx = {
  tools: { register: (def) => { tools[def.name] = def } },
  attachments: {
    saveImage: async (input) => {
      savedImage = input
      return { attachmentId: 'sha256:test-stub', mediaType: 'image/png', bytes: input.data.length, width: 1440, height: 3168 }
    },
  },
}
apply(ctx, {})

const names = Object.keys(tools)
console.log(`  registered ${names.length} tools: ${names.join(', ')}\n`)

let fails = 0
const bad = (msg) => { fails++; console.log(`  ❌ ${msg}`) }

// ── 1. every definition declares parameters / output / execute ──────────────
console.log('  --- definition shape ---')
for (const n of names) {
  const d = tools[n]
  const problems = []
  if (d.parameters?.type !== 'object') problems.push('parameters is not an object schema')
  if (!d.output?.schema) problems.push('output.schema missing')
  if (typeof d.output?.render !== 'function') problems.push('output.render missing')
  if (typeof d.execute !== 'function') problems.push('execute missing')
  if (problems.length) bad(`${n}: ${problems.join('; ')}`)
}
if (fails === 0) console.log(`  ✅ all ${names.length} definitions are complete`)

// ── 2. required[] must only name declared properties ───────────────────────
console.log('\n  --- argument schema sanity ---')
for (const n of names) {
  const p = tools[n].parameters
  const orphan = (p.required ?? []).filter((k) => !(k in (p.properties ?? {})))
  if (orphan.length) bad(`${n}: required[] names undeclared properties: ${orphan.join(', ')}`)
}
if (fails === 0) console.log('  ✅ every required[] entry is declared')

// ── 3. drive every tool and validate each returned value ───────────────────
console.log('\n  --- live calls (value validated against output.schema) ---')
async function call(name, args) {
  const d = tools[name]
  let value
  try {
    value = await d.execute(args, { signal: undefined, agent: { id: 'test' } })
  } catch (e) {
    bad(`${name} threw: ${e.message}`)
    return null
  }
  const errs = validate(d.output.schema, value)
  if (errs.length) {
    bad(`${name} returned a value its own output.schema rejects:`)
    for (const e of errs) console.log(`       ${e}`)
    return null
  }
  try {
    const blocks = d.output.render(args, value)
    if (!Array.isArray(blocks) || blocks.length === 0) bad(`${name}.render returned no content blocks`)
  } catch (e) {
    bad(`${name}.render threw: ${e.message}`)
  }
  console.log(`  ✅ ${name}`)
  return value
}

const info = await call('android_info', {})
if (info) console.log(`       ${info.model} / Android ${info.android} / ${info.screen} / battery ${info.battery}`)

const shot = await call('android_screenshot', { label: 'schema-test' })
if (shot) {
  const blocks = tools.android_screenshot.output.render({}, shot)
  const img = blocks.find((b) => b.type === 'image')
  if (!img) bad('android_screenshot.render produced no image block')
  else if (img.attachment?.mediaType !== 'image/png') bad(`image block mediaType is ${img.attachment?.mediaType}`)
  else console.log(`       image block ok (${img.attachment.width}x${img.attachment.height}), stored ${savedImage?.data?.length} bytes`)
}

await call('android_app', { action: 'current' })
await call('android_shell', { command: 'echo ok && getprop ro.product.brand' })
await call('android_key', { key: 'home' })
await call('android_tap', { x: 10, y: 10 })
await call('android_swipe', { from_x: 720, from_y: 2200, to_x: 720, to_y: 900, duration_ms: 150 })

// ── 4. error paths must be actionable, not stack traces ────────────────────
console.log('\n  --- error paths ---')
const expectReject = async (name, args, needle) => {
  try {
    await tools[name].execute(args, { signal: undefined })
    bad(`${name} accepted invalid input it should have rejected`)
  } catch (e) {
    if (needle && !e.message.includes(needle)) bad(`${name} error lacks "${needle}": ${e.message.slice(0, 80)}`)
    else console.log(`  ✅ ${name} rejected with a fixable message`)
  }
}
await expectReject('android_type', { text: '中文' }, 'ADBKeyboard')
await expectReject('android_key', { key: 'nonsense' }, 'unknown key')
await expectReject('android_app', { action: 'start' }, 'needs a package name')
await expectReject('android_app', { action: 'wrong' }, 'unknown action')

console.log(`\n  ${fails === 0 ? '★ all checks passed' : `✗ ${fails} failure(s)`}`)
process.exit(fails === 0 ? 0 : 1)
