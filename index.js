/**
 * dsh-android-control — drive an Android phone from DeepSeek Harness over ADB.
 *
 * Gives the model the same loop it has on the host: look at the screen, decide,
 * act, look again. Everything is one `adb` invocation underneath; the value
 * added here is (a) binary-safe screenshots returned as real image content,
 * (b) argument shapes that fail with a fixable message instead of an adb stack
 * trace, and (c) a stable tool surface the model can plan against.
 *
 * Tool definitions are plain objects registered straight into `ctx.tools`, with
 * standard JSON Schema for `parameters` and `output.schema` — the same shape
 * the registry's own built-ins and pygmalion use, so no `defineTool` import is
 * needed (that package is not resolvable from a profile's node_modules).
 *
 * @module dsh-android-control
 */

import { adbText, screenshotPng, requireDevice, resolveAdb } from './adb.js'

/** Cordis plugin name. */
export const name = 'android-control'
/** Services this plugin needs: the tool registry, and attachments for screenshots. */
export const inject = ['tools', 'attachments']

/**
 * The common shape: a single `output` string rendered as one text block.
 *
 * `render` is not optional — the registry refuses a tool whose `output` lacks
 * `{ schema, render }`, so every definition here must carry both.
 */
const textResult = (properties, required = ['output']) => ({
  schema: { type: 'object', additionalProperties: false, properties, required },
  render: (_args, value) => [{ type: 'text', text: String(value.output ?? '') }],
})

const OUTPUT_ONLY = textResult({ output: { type: 'string', description: 'Command output or a confirmation line.' } })

/**
 * `adb shell input text` accepts only printable ASCII and treats a space as an
 * argument separator, so spaces are escaped to %s — the documented workaround.
 * Anything outside ASCII cannot travel this path at all.
 */
function encodeInputText(text) {
  if (/[^\x20-\x7E]/.test(text)) {
    throw new Error(
      'input text only carries printable ASCII. For Chinese or emoji, install the ADBKeyboard IME on the phone '
      + '(github.com/senzhk/ADBKeyBoard), enable it, then use android_shell with: '
      + 'am broadcast -a ADB_INPUT_TEXT --es msg "文本"',
    )
  }
  return text.replace(/ /g, '%s').replace(/([\\"'`$&|;<>()*?[\]{}~^!#])/g, '\\$1')
}

const KEY_ALIASES = {
  home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', enter: 'KEYCODE_ENTER', menu: 'KEYCODE_MENU',
  power: 'KEYCODE_POWER', wake: 'KEYCODE_WAKEUP', sleep: 'KEYCODE_SLEEP',
  appswitch: 'KEYCODE_APP_SWITCH', recents: 'KEYCODE_APP_SWITCH',
  volumeup: 'KEYCODE_VOLUME_UP', volumedown: 'KEYCODE_VOLUME_DOWN', mute: 'KEYCODE_VOLUME_MUTE',
  up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN', left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT',
  tab: 'KEYCODE_TAB', escape: 'KEYCODE_ESCAPE', delete: 'KEYCODE_DEL', backspace: 'KEYCODE_DEL',
  camera: 'KEYCODE_CAMERA', search: 'KEYCODE_SEARCH', playpause: 'KEYCODE_MEDIA_PLAY_PAUSE',
}

const int = (v) => Math.trunc(v)

/**
 * Register every android_* tool.
 *
 * Configuration arrives as the second argument (the Cordis convention), not via
 * `ctx.config` — reading `ctx.config` throws unless 'config' is declared in
 * `inject`, and a plugin that merely wants an optional override should not block
 * activation on a config service.
 *
 * @param ctx - context providing the tool registry and the attachment store.
 * @param config - optional `{ adbPath }` override for the adb binary.
 */
export function apply(ctx, config) {
  const adbPath = config?.adbPath
  const target = (signal) => requireDevice(adbPath, signal)

  // Track what actually landed. Activation failures surface as a generic
  // "entry did not activate" warning, so naming the registered tools and the
  // resolved adb binary here is the fastest way to tell a real load from a
  // silent one.
  const registered = []
  const reg = (def) => { ctx.tools.register(def); registered.push(def.name) }
  ctx.effect?.(() => () => {
    // Runs on dispose; stderr because the logger may already be torn down.
    process.stderr.write(`[android-control] unloaded after registering ${registered.length} tools\n`)
  })

  // ── observe ───────────────────────────────────────────────────────────────
  reg({
    name: 'android_screenshot',
    description:
      'Capture the phone screen and return it as an image you can actually see. This is the primary way to observe Android UI: '
      + 'screenshot, read the layout, act with android_tap / android_swipe / android_type, then screenshot again to verify. '
      + 'Coordinates in the returned image map 1:1 onto android_tap arguments.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        label: { type: 'string', description: 'Optional short label stored with the attachment, e.g. "after tapping Send".' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', description: 'Durable id of the stored screenshot.' },
          width: { type: 'integer', description: 'Screen width in pixels; tap x must be below this.' },
          height: { type: 'integer', description: 'Screen height in pixels; tap y must be below this.' },
          // `bytes` must be declared: the registry validates the returned value
          // against this schema with additionalProperties:false, so returning a
          // field that is not listed here fails the whole call.
          bytes: { type: 'integer', description: 'Encoded PNG size in bytes.' },
        },
        required: ['attachmentId', 'width', 'height', 'bytes'],
      },
      render: (_args, value) => [
        { type: 'text', text: `Phone screen ${value.width}x${value.height}. android_tap uses this same pixel space.` },
        {
          type: 'image',
          attachment: {
            attachmentId: value.attachmentId,
            mediaType: 'image/png',
            bytes: value.bytes ?? 0,
            width: value.width,
            height: value.height,
          },
        },
      ],
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      await target(exec.signal)
      const png = await screenshotPng(adbPath, exec.signal)
      // A blank buffer means the panel produced nothing (screen off / secure window).
      if (!png || png.length === 0) {
        throw new Error('screencap returned no data — the screen may be off; try android_key with "wake" first')
      }
      const ref = await ctx.attachments.saveImage({
        data: new Uint8Array(png),
        mediaType: 'image/png',
        name: `${String(args.label ?? 'android-screen').replace(/[^\w.-]+/g, '-').slice(0, 60)}.png`,
      })
      return { attachmentId: String(ref.attachmentId), width: ref.width, height: ref.height, bytes: ref.bytes }
    },
  })

  reg({
    name: 'android_info',
    description:
      'Read device facts: model, Android version, screen size and density, battery, storage. '
      + 'Call this once to learn the screen pixel space before computing tap coordinates.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          model: { type: 'string' }, android: { type: 'string' }, screen: { type: 'string' },
          density: { type: 'string' }, battery: { type: 'string' }, storage: { type: 'string' },
        },
        required: ['model', 'android', 'screen', 'density', 'battery', 'storage'],
      },
      render: (_a, v) => [{
        type: 'text',
        text: [`model   : ${v.model}`, `android : ${v.android}`, `screen  : ${v.screen}`,
          `density : ${v.density}`, `battery : ${v.battery}`, `storage : ${v.storage}`].join('\n'),
      }],
    },
    timeoutMs: 60_000,
    async execute(_args, exec) {
      await target(exec.signal)
      const opt = { adbPath, signal: exec.signal }
      const [model, android, size, density, batt, df] = await Promise.all([
        adbText(['shell', 'getprop', 'ro.product.model'], opt),
        adbText(['shell', 'getprop', 'ro.build.version.release'], opt),
        adbText(['shell', 'wm', 'size'], opt),
        adbText(['shell', 'wm', 'density'], opt),
        adbText(['shell', 'dumpsys', 'battery'], opt),
        adbText(['shell', 'df', '-h', '/sdcard'], opt),
      ])
      return {
        model,
        android,
        screen: size.replace(/^Physical size:\s*/i, '').trim(),
        density: density.replace(/^Physical density:\s*/i, '').trim(),
        battery: `${batt.split('\n').find((l) => l.includes('level:'))?.split(':')[1]?.trim() ?? '?'}%`,
        storage: df.split('\n').pop()?.replace(/\s+/g, ' ').trim() ?? '?',
      }
    },
  })

  // ── act ───────────────────────────────────────────────────────────────────
  reg({
    name: 'android_tap',
    description:
      'Tap a point on the phone screen. Use coordinates measured from an android_screenshot image. '
      + 'Aiming at a control\'s centre is far more reliable than its edge.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        x: { type: 'integer', description: 'Horizontal pixel coordinate from the left edge.' },
        y: { type: 'integer', description: 'Vertical pixel coordinate from the top edge.' },
        repeat: { type: 'integer', description: 'How many taps (default 1). Use 2 for a double-tap.' },
      },
      required: ['x', 'y'],
    },
    output: OUTPUT_ONLY,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const count = Math.max(1, Math.min(10, int(args.repeat ?? 1)))
      await target(exec.signal)
      for (let i = 0; i < count; i++) {
        await adbText(['shell', 'input', 'tap', String(int(args.x)), String(int(args.y))], { adbPath, signal: exec.signal })
      }
      return { output: `Tapped (${int(args.x)}, ${int(args.y)})${count > 1 ? ` ${count} times` : ''}.` }
    },
  })

  reg({
    name: 'android_swipe',
    description:
      'Drag across the phone screen: scroll (swipe up to move content down), dismiss notifications, fling a list. '
      + 'A short duration (~150 ms) is a fling; a long one (~800 ms) is a precise drag that avoids over-scrolling.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from_x: { type: 'integer', description: 'Start x.' },
        from_y: { type: 'integer', description: 'Start y.' },
        to_x: { type: 'integer', description: 'End x.' },
        to_y: { type: 'integer', description: 'End y.' },
        duration_ms: { type: 'integer', description: 'Gesture duration in milliseconds (default 300).' },
      },
      required: ['from_x', 'from_y', 'to_x', 'to_y'],
    },
    output: OUTPUT_ONLY,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const d = Math.max(1, int(args.duration_ms ?? 300))
      await target(exec.signal)
      await adbText(['shell', 'input', 'swipe',
        String(int(args.from_x)), String(int(args.from_y)),
        String(int(args.to_x)), String(int(args.to_y)), String(d)], { adbPath, signal: exec.signal })
      return { output: `Swiped (${int(args.from_x)},${int(args.from_y)}) -> (${int(args.to_x)},${int(args.to_y)}) over ${d} ms.` }
    },
  })

  reg({
    name: 'android_type',
    description:
      'Type text into the focused field. ASCII only — Chinese and emoji need the ADBKeyboard IME on the phone '
      + '(the error message carries the exact command). Tap the field first so it holds focus.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { text: { type: 'string', description: 'The text to type. Spaces are handled correctly.' } },
      required: ['text'],
    },
    output: OUTPUT_ONLY,
    timeoutMs: 60_000,
    async execute(args, exec) {
      await target(exec.signal)
      await adbText(['shell', 'input', 'text', encodeInputText(args.text)], { adbPath, signal: exec.signal })
      return { output: `Typed ${String(args.text).length} character(s).` }
    },
  })

  reg({
    name: 'android_key',
    description:
      'Press a navigation or hardware key. Named keys: home, back, enter, menu, power, wake, sleep, appswitch (recent apps), '
      + 'volumeup, volumedown, mute, up, down, left, right, tab, escape, delete, camera, search, playpause. '
      + 'A raw KEYCODE_* constant is accepted too.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { key: { type: 'string', description: 'A friendly name from the list, or a raw KEYCODE_* constant.' } },
      required: ['key'],
    },
    output: OUTPUT_ONLY,
    timeoutMs: 60_000,
    async execute(args, exec) {
      const raw = String(args.key).trim()
      const code = KEY_ALIASES[raw.toLowerCase()] ?? (/^KEYCODE_[A-Z0-9_]+$/i.test(raw) ? raw.toUpperCase() : undefined)
      if (code === undefined) {
        throw new Error(`unknown key "${raw}" — use one of: ${Object.keys(KEY_ALIASES).join(', ')}, or a raw KEYCODE_* name`)
      }
      await target(exec.signal)
      await adbText(['shell', 'input', 'keyevent', code], { adbPath, signal: exec.signal })
      return { output: `Pressed ${code}.` }
    },
  })

  // ── apps ──────────────────────────────────────────────────────────────────
  reg({
    name: 'android_app',
    description:
      'Inspect or control installed apps. action=list returns third-party packages; action=current reports the foreground window; '
      + 'action=start launches a package; action=stop force-stops it. Package names look like com.tencent.mm.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'current', 'start', 'stop'], description: 'What to do.' },
        package: { type: 'string', description: 'Package name; required for start and stop.' },
      },
      required: ['action'],
    },
    output: OUTPUT_ONLY,
    timeoutMs: 90_000,
    async execute(args, exec) {
      await target(exec.signal)
      const opt = { adbPath, signal: exec.signal }
      switch (args.action) {
        case 'list': {
          const out = await adbText(['shell', 'pm', 'list', 'packages', '-3'], opt)
          const pkgs = out.split('\n').map((l) => l.replace(/^package:/, '').trim()).filter(Boolean)
          return { output: `${pkgs.length} third-party packages:\n${pkgs.join('\n')}` }
        }
        case 'current': {
          const out = await adbText(['shell', 'dumpsys', 'window'], { ...opt, timeoutMs: 30_000 })
          return { output: out.split('\n').find((l) => l.includes('mCurrentFocus'))?.trim() ?? '(no focused window reported)' }
        }
        case 'start': {
          if (!args.package) throw new Error('action=start needs a package name, e.g. com.tencent.mm')
          // monkey resolves the launcher activity for us instead of guessing it.
          const out = await adbText(['shell', 'monkey', '-p', args.package, '-c', 'android.intent.category.LAUNCHER', '1'], opt)
          if (/No activities found|aborted/i.test(out)) {
            throw new Error(`could not launch ${args.package} — verify the name with android_app action=list`)
          }
          return { output: `Launched ${args.package}.` }
        }
        case 'stop': {
          if (!args.package) throw new Error('action=stop needs a package name')
          await adbText(['shell', 'am', 'force-stop', args.package], opt)
          return { output: `Force-stopped ${args.package}.` }
        }
        default:
          throw new Error(`unknown action "${args.action}" — expected: list, current, start, stop`)
      }
    },
  })

  // ── escape hatch ──────────────────────────────────────────────────────────
  reg({
    name: 'android_shell',
    description:
      'Escape hatch: run an arbitrary shell command on the phone and return its stdout. '
      + 'Use it for anything the typed tools do not cover — listing /sdcard, querying settings, broadcasting to a helper IME. '
      + 'Prefer the typed tools for interaction, since they are validated; do not use this to change system settings you cannot undo.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: { type: 'string', description: 'Shell command, e.g. "ls -la /sdcard/DCIM/Camera | head".' },
        timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (default 30000).' },
      },
      required: ['command'],
    },
    output: OUTPUT_ONLY,
    timeoutMs: 300_000,
    async execute(args, exec) {
      await target(exec.signal)
      const out = await adbText(['shell', args.command], {
        adbPath,
        signal: exec.signal,
        timeoutMs: Math.max(1_000, Math.min(300_000, int(args.timeout_ms ?? 30_000))),
      })
      return { output: out.length === 0 ? '(no output)' : out.slice(0, 60_000) }
    },
  })

  process.stderr.write(
    `[android-control] ready: ${registered.length} tools (${registered.join(', ')}) via ${resolveAdb(adbPath)}\n`,
  )
}

/** Diagnostics helper: which adb the plugin will use. */
export function describe() {
  return { name, inject, adb: resolveAdb(undefined) }
}
