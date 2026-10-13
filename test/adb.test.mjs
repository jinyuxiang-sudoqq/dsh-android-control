import { resolveAdb, deviceState, requireDevice, screenshotPng, adbText } from '../adb.js'

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) fails++
}

// 1. adb 解析
const path = resolveAdb(undefined)
check('resolveAdb 找到 adb', path !== undefined, path)

// 2. 设备状态
const state = await deviceState(undefined)
check('deviceState 返回结构', Array.isArray(state.ready) && Array.isArray(state.unauthorised))

// 3. requireDevice
let device
try { device = await requireDevice(undefined); check('requireDevice 拿到序列号', typeof device === 'string', device) }
catch (e) { check('requireDevice', false, e.message) }

// 4. 二进制截图（关键：不能被 CRLF 改坏）
try {
  const png = await screenshotPng(undefined)
  const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4E && png[3] === 0x47
  check('screenshotPng 二进制安全（PNG 魔数正确）', isPng, `${png.length} bytes, 头=${[...png.slice(0,4)].map(b=>b.toString(16)).join(' ')}`)
} catch (e) { check('screenshotPng', false, e.message) }

// 5. 文本命令
try {
  const model = await adbText(['shell', 'getprop', 'ro.product.model'])
  check('adbText 读设备信息', model.length > 0, model)
} catch (e) { check('adbText', false, e.message) }

console.log(`\n  ${fails === 0 ? '全部通过' : fails + ' 项失败'}`)
process.exit(fails === 0 ? 0 : 1)