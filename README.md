# dsh-android-control

让 DeepSeek Harness 直接操作一台安卓手机 —— **截图看得见、点击点得中、动作可验证**。

模型在电脑上有「看 → 想 → 动」的闭环，装上这个插件后，它在手机上也有同一个闭环：

```
android_screenshot  →  模型真的看到画面
android_tap/swipe/type/key  →  真的操作
android_screenshot  →  再截一张，验证刚才那一下有没有生效
```

## 依赖

只有一样：**adb**（Android platform-tools）。

插件按这个顺序找它：

1. 配置里的 `adbPath`
2. 环境变量 `ANDROID_CONTROL_ADB`
3. 常见安装路径（`~/Desktop/android-control/platform-tools/`、`~/AppData/Local/Android/Sdk/platform-tools/`、`~/scoop/apps/adb/`、`C:\platform-tools\`、chocolatey、`/usr/bin/adb` …）
4. `PATH` 上的 `adb`

没装的话，从 <https://developer.android.com/tools/releases/platform-tools> 拿一个解压即可，不用装整个 Android SDK。

## 手机侧一次性设置

```
设置 → 关于本机 → 版本信息 → 连点「版本号」7 次     （开启开发者选项）
设置 → 系统设置 → 开发者选项 → ✅ USB 调试
插上数据线 → 手机上弹「允许 USB 调试吗？」→ 勾「一律允许」→ 允许
```

验证：

```bash
adb devices
# 期望看到  <device-serial>   device
```

> **无线调试**需要手机自己连着一个 Wi-Fi。如果手机正在开热点给电脑用，
> Wi-Fi 射频被热点占用，无线调试会开不起来 —— 这种情况直接用数据线。

## 工具

| 工具 | 作用 |
|---|---|
| `android_screenshot` | 截图并**作为图像返回**，模型能直接看 |
| `android_info` | 型号 / Android 版本 / 屏幕像素 / 密度 / 电量 / 存储 |
| `android_tap` | 点击 `(x, y)`，`repeat` 可双击 |
| `android_swipe` | 滑动（滚动、下拉通知、甩列表），`duration_ms` 区分「甩」和「拖」 |
| `android_type` | 往聚焦的输入框打字（**仅 ASCII**，见下） |
| `android_key` | 按键：home / back / enter / appswitch / wake … 也接受原始 `KEYCODE_*` |
| `android_app` | `list` 列第三方应用 / `current` 看前台窗口 / `start` 启动 / `stop` 强停 |
| `android_shell` | 逃生舱：跑任意 shell 命令 |

## 三个已知边界

**1. `android_type` 只支持 ASCII。**
`adb shell input text` 本身就走不了非 ASCII。中文/表情需要手机装
[ADBKeyboard](https://github.com/senzhk/ADBKeyBoard) 输入法并启用，然后：

```bash
android_shell: am broadcast -a ADB_INPUT_TEXT --es msg "中文内容"
```

插件在收到非 ASCII 时会直接把这条命令放在报错里。

**2. 截图必须是 `exec-out`，不能是 `shell`。**
`adb shell screencap -p` 会经过一个把 LF 改写成 CRLF 的 pty，**PNG 会被改坏**。
插件内部用的是 `adb exec-out screencap -p`，二进制安全。

**3. 非 root 的能力上限。**
能：截图、点击、滑动、输入、装/卸应用、读写 `/sdcard`、跑 shell。
不能：读其他 App 的私有数据（聊天记录、已保存的密码）、改系统级设置。
另外银行/支付类 App 常带反截图，可能截出黑屏。

## 安全

开着 USB 调试就等于**给了这台电脑完整的 shell 权限**。所以：

- 在公共电脑或公共 Wi-Fi 场景下**关掉 USB 调试**
- 不用的时候拔线，或撤销授权：`adb kill-server`
- 手机侧的「撤销 USB 调试授权」可以一键清掉已信任的电脑

## 安装

```bash
dsh plugin --profile web add <本目录路径>
```

然后确认 profile 的 `package.json` 里 `dsh.profile.bundles` 已列出 `dsh-android-control`：

```json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-android-control"]
    }
  }
}
```

重启 dsh 后，工具就会出现在 agent 的工具列表里。

## 隐私

**`android_screenshot` 会把手机当前屏幕的全部内容交给模型** —— 没有遮挡，没有过滤。
屏幕上是聊天记录就是聊天记录，是银行 App 就是银行 App。

- 别在聊天、支付、密码界面触发截图
- 这些图会落进 DSH 的附件库（`$DSH_HOME/attachments/`），需要的话定期清理
- 需要操作某个 App 时，先切到安全界面再截

`android_shell` 能跑任意命令，能力等同于一台连着线的调试机。**公共电脑上用完请 `adb kill-server` 并撤销手机上的 USB 调试授权。**

## 写 DSH 插件踩过的四个坑

这个插件是照着 DSH 内置工具的写法做的，过程中撞了四次墙。记下来，省得下一个人重踩：

**1. `ctx.config` 会抛异常。**
```
Error: cannot get property "config" without inject
```
`ctx.config` 需要把 `'config'` 声明进 `inject`，而插件通常只想要一个可选覆盖项。
**正确写法是 Cordis 的约定：`export function apply(ctx, config)`** —— 配置走第二个参数。

**2. `output` 必须同时有 `schema` 和 `render`。**
```
TypeError: tool "x" must declare output { schema, render, ... }
```
少任何一个都会被注册表拒绝。写辅助函数时特别容易漏 —— 我就是只返回了 `schema`。

**3. `@deepseek-ai/dsh-tools` 从 profile 的 `node_modules` 里解析不到。**
所以 **`defineTool` 用不了**（它会把 DSH 的参数 DSL 转成标准 JSON Schema，并加执行前校验）。
**替代方案：直接 `ctx.tools.register(普通对象)`，`parameters` 和 `output.schema` 写标准 JSON Schema** —— pygmalion 就是这么干的。

**4. 返回值的字段必须在 `output.schema` 里声明。**
`additionalProperties: false` 之下，多返回一个字段会让**每一次真实调用**都校验失败，
而直接调 `execute()` 的测试**不会发现** —— 因为那绕过了注册表的输出校验。
`test/plugin.test.mjs` 里的 `validate()` 就是为这个补的。

## 测试

两个测试都不经过 LLM，所以零成本、可反复跑：

```bash
node test/adb.test.mjs      # ADB 层：定位、设备状态、PNG 二进制安全
node test/plugin.test.mjs   # 全部 8 个工具：schema 完整性 + 真实调用 + 错误路径
```

`plugin.test.mjs` 用 `validate()` 把每个工具的返回值对照它自己的 `output.schema` 校验一遍
—— 这是唯一能抓住上面第 4 条那类 bug 的方式。

## 许可

MIT
