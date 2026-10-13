/**
 * Minimal ADB runner for the dsh-android-control plugin.
 *
 * Everything the plugin does funnels through here, so this file owns the two
 * things that are easy to get wrong:
 *   1. locating a usable adb binary, and
 *   2. binary-safe output (screencap writes a PNG to stdout, and the default
 *      utf8 decoding would corrupt it).
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Places adb is commonly installed, tried in order after $PATH and config. */
const WELL_KNOWN = [
  join(homedir(), 'Desktop', 'android-control', 'platform-tools', 'adb.exe'),
  join(homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  join(homedir(), 'scoop', 'apps', 'adb', 'current', 'adb.exe'),
  'C:\\platform-tools\\adb.exe',
  'C:\\ProgramData\\chocolatey\\bin\\adb.exe',
  '/usr/bin/adb',
  '/usr/local/bin/adb',
  join(homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
]

let cachedAdb

/**
 * Resolve the adb executable once.
 * @param explicit - a path from plugin config, if the user set one.
 * @returns the path or bare name to invoke.
 */
export function resolveAdb(explicit) {
  if (cachedAdb !== undefined) return cachedAdb
  const candidates = [explicit, process.env.ANDROID_CONTROL_ADB, ...WELL_KNOWN].filter(Boolean)
  for (const candidate of candidates) {
    // A bare name (`adb`) is left for the OS to resolve via PATH.
    if (candidate === 'adb' || candidate.endsWith('adb') || candidate.endsWith('adb.exe')) {
      if (!candidate.includes('/') && !candidate.includes('\\')) { cachedAdb = candidate; return cachedAdb }
      if (existsSync(candidate)) { cachedAdb = candidate; return cachedAdb }
    }
  }
  cachedAdb = 'adb'
  return cachedAdb
}

/**
 * Run adb and settle with its stdout.
 * @param args - argv after the binary name.
 * @param options - `binary` keeps stdout as a Buffer; `timeoutMs` defaults to 30s.
 * @returns stdout as a string, or a Buffer when `binary` is set.
 */
export function adb(args, options = {}) {
  const { binary = false, timeoutMs = 30_000, adbPath, signal } = options
  return new Promise((resolve, reject) => {
    execFile(
      resolveAdb(adbPath),
      args,
      {
        encoding: binary ? 'buffer' : 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true,
        ...(signal === undefined ? {} : { signal }),
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr ?? '').toString().trim()
          reject(new Error(`adb ${args.join(' ')} failed: ${detail || error.message}`))
          return
        }
        const noise = (stderr ?? '').toString().trim()
        // adb writes progress chatter to stderr on success; surface it only when
        // the caller explicitly asked for verbose output.
        resolve(binary ? stdout : { stdout: stdout.toString(), stderr: noise })
      },
    )
  })
}

/** Run adb and return trimmed stdout text, throwing on a non-zero exit. */
export async function adbText(args, options = {}) {
  const { stdout } = await adb(args, options)
  return stdout.trim()
}

/** True when exactly one device is attached and authorised. */
export async function deviceState(adbPath) {
  const out = await adbText(['devices'], { adbPath })
  const lines = out.split('\n').slice(1).map((l) => l.trim()).filter(Boolean)
  const ready = lines.filter((l) => /\tdevice$/.test(l)).map((l) => l.split('\t')[0])
  const unauthorised = lines.filter((l) => /unauthorized/.test(l)).map((l) => l.split('\t')[0])
  const offline = lines.filter((l) => /offline/.test(l)).map((l) => l.split('\t')[0])
  return { ready, unauthorised, offline }
}

/** Throw a message that tells the user how to fix a missing connection. */
export async function requireDevice(adbPath) {
  const state = await deviceState(adbPath)
  if (state.ready.length === 1) return state.ready[0]
  if (state.unauthorised.length > 0) {
    throw new Error('the phone is connected but not authorised — unlock it and tap "Allow" on the USB debugging prompt')
  }
  if (state.offline.length > 0) {
    throw new Error('the phone is listed as offline — replug the USB cable, or run: adb reconnect')
  }
  if (state.ready.length > 1) {
    throw new Error(`${state.ready.length} devices are attached; disconnect the others or target one explicitly`)
  }
  throw new Error('no Android device detected — plug in the USB cable and enable USB debugging in Developer options')
}

/**
 * Take a screenshot and return the raw PNG bytes.
 *
 * `exec-out` is required rather than `shell`: `shell` runs the command through
 * a pty that rewrites LF to CRLF and corrupts the PNG.
 */
export async function screenshotPng(adbPath, signal) {
  return adb(['exec-out', 'screencap', '-p'], { binary: true, timeoutMs: 20_000, adbPath, signal })
}
