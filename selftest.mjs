// 按 dsh-client-modules / dsh-app-boot 的校验规则自测 wb-credits 插件声明，
// 并静态检查 bundle 语法。
// 规则来源：
//   node_modules/@deepseek-ai/dsh-client-modules/lib/index.js  L53-L68（dsh.client）
//                                                            L170-L180（exports["./client"]）
//   node_modules/@deepseek-ai/dsh-app-boot/lib/index.js        L1632-L1656（icon 校验）
//                                                            L1706-L1725（locale 字典）
//                                                            L726（profile bundle 需 dsh.bundle）
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'

const pkgDir = 'D:/AiLearn/my-DSH/plugins/wb-credits'
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))

const fail = []
const note = (ok, msg) => console.log(`${ok ? '[PASS]' : '[FAIL]'} ${msg}`) || (ok || fail.push(msg))

// --- dsh.bundle：决定它是不是一个"标准 bundle" ---
// dsh-plugin-manager L1025：declares no dsh.bundle 会被直接 refused("not-a-bundle")。
if (typeof pkg.dsh?.bundle?.patch !== 'string' || pkg.dsh.bundle.patch === '') {
  note(false, 'dsh.bundle.patch 未声明（Plugin Manager 会判为 not-a-bundle）')
} else {
  note(true, `dsh.bundle.patch 已声明 (=${pkg.dsh.bundle.patch})`)
  const patchPath = resolve(pkgDir, pkg.dsh.bundle.patch)
  note(existsSync(patchPath), `bundle patch 文件存在: ${patchPath}`)
  // patch 里的 name 必须是包名（而不是绝对路径），否则装进 profile 后解析不到。
  if (existsSync(patchPath)) {
    const yml = readFileSync(patchPath, 'utf8')
    // 只检查生效行：注释里允许出现绝对路径的示例写法。
    const effective = yml
      .split(/\r?\n/)
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    note(new RegExp(`name:\\s*'?"?${pkg.name}`).test(effective), `patch 的 name 是包名 (${pkg.name})`)
    note(!/name:\s*[A-Za-z]:[\\/]/.test(effective), 'patch 未使用绝对路径挂载（标准形态）')
  }
}

// --- dsh.client 声明 ---
if (typeof pkg.dsh?.client !== 'object' || pkg.dsh.client === null) {
  note(false, 'dsh.client 不是对象')
} else {
  const decl = pkg.dsh.client
  const arr = (v, f) =>
    v === undefined || (Array.isArray(v) && v.every((i) => typeof i === 'string'))
      ? true
      : (note(false, `dsh.client.${f} 必须是字符串数组`), false)

  note(typeof decl.platform === 'string', `dsh.client.platform 是字符串 (=${decl.platform})`)
  note(arr(decl.inject, 'inject'), `dsh.client.inject 是字符串数组 (${(decl.inject ?? []).length} 项)`)
  note(arr(decl.external, 'external'), 'dsh.client.external 合法或未声明')
  note(decl.immediately === undefined || typeof decl.immediately === 'boolean', 'dsh.client.immediately 合法或未声明')
  note(decl.immediately === true, 'dsh.client.immediately 已置 true（与官方模板一致，首屏加载调度）')
  note(
    (decl.inject ?? []).includes('@deepseek-ai/dsh-client-ui-slots'),
    'inject 声明了 slots 依赖包',
  )
}

// --- exports["./client"] 可解析 ---
const clientExport = pkg.exports?.['./client']
const def = typeof clientExport === 'string' ? clientExport : clientExport?.default
note(typeof def === 'string', 'exports["./client"] 解析为字符串')
const bundlePath = def ? resolve(pkgDir, def) : ''
note(bundlePath !== '' && existsSync(bundlePath), `bundle 存在: ${bundlePath}`)

// --- bundle 语法（工厂格式，不是 ESM）---
try {
  const src = readFileSync(bundlePath, 'utf8')
  note(src.includes('window.__ModuleLoader__.load('), 'bundle 使用 __ModuleLoader__.load 工厂格式')
  note(new RegExp(`id:\\s*'${pkg.name}'`).test(src), `bundle 注册 id 为 '${pkg.name}'`)
  // 语法检查：当作脚本解析（不是 module）
  new (await import('node:vm')).Script(src)
  note(true, 'bundle 语法解析通过')
} catch (e) {
  note(false, `bundle 语法错误: ${e.message}`)
}

// --- host 半边 ---
const hostEntry = resolve(pkgDir, pkg.main ?? 'lib/index.js')
note(existsSync(hostEntry), `host 入口存在: ${hostEntry}`)
note(pkg.name === 'wb-credits', `包名与注册 id 一致 (${pkg.name})`)

// --- dsh.bundle 的 patch 必须被 exports 暴露（否则 resolveBundleDir 之后读不到）---
note(
  Object.hasOwn(pkg.exports ?? {}, './cordis.patch.yml'),
  'exports 暴露了 ./cordis.patch.yml（bundle patch 可解析）',
)

// --- locale 显示元数据（Plugin Manager 卡片读它，且不激活插件）---
// dsh-app-boot L1750：缺 en.json 会回退成裸包名 + description。
const enPath = join(pkgDir, 'locale', 'en.json')
note(existsSync(enPath), 'locale/en.json 存在（缺失则回退成裸包名）')
const locales = ['en', 'zh']
for (const lang of locales) {
  const p = join(pkgDir, 'locale', `${lang}.json`)
  if (!existsSync(p)) {
    note(false, `locale/${lang}.json 缺失`)
    continue
  }
  try {
    const dict = JSON.parse(readFileSync(p, 'utf8'))
    note(typeof dict.meta?.title === 'string' && dict.meta.title !== '', `locale/${lang}.json 有 meta.title`)
    note(
      typeof dict.meta?.description === 'string' && dict.meta.description !== '',
      `locale/${lang}.json 有 meta.description`,
    )
  } catch (e) {
    note(false, `locale/${lang}.json 不是合法 JSON: ${e.message}`)
  }
}
// exports 必须暴露 locale 通配，否则 resolvePluginResource 解析不到。
note(Object.hasOwn(pkg.exports ?? {}, './locale/*.json'), 'exports 暴露了 ./locale/*.json')

// --- icon ---
// dsh-app-boot L1641-L1656：必须相对路径、限 SVG/PNG/JPEG/WebP、≤256 KiB、不得越出包目录。
if (typeof pkg.icon !== 'string' || pkg.icon === '') {
  note(false, 'icon 未声明（回退到面板默认图）')
} else {
  note(!/^([A-Za-z]:[\\/]|[\\/]|[A-Za-z][A-Za-z\d+.-]*:)/.test(pkg.icon), 'icon 是相对路径')
  note(['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(pkg.icon.toLowerCase().slice(pkg.icon.lastIndexOf('.'))),
    `icon 扩展名受支持 (${pkg.icon})`)
  const iconPath = resolve(pkgDir, pkg.icon)
  note(existsSync(iconPath), `icon 文件存在: ${iconPath}`)
  if (existsSync(iconPath)) {
    const size = statSync(iconPath).size
    note(size <= 256 * 1024, `icon 体积 ${size} B ≤ 256 KiB`)
    // dsh-app-boot L1649-L1650：realpath 之后不得越出 manifest 所在目录。
    const local = relative(pkgDir, iconPath)
    note(local !== '..' && !local.startsWith('..' + sep) && !isAbsolute(local), 'icon 位于包目录内')
  }
}

// --- 双端点路径一致性（host 常量 vs 客户端 bundle 内的字面量）---
try {
  const hostSrc = readFileSync(hostEntry, 'utf8')
  const clientSrc = readFileSync(bundlePath, 'utf8')
  const hostPaths = [...hostSrc.matchAll(/'(\/api\/workbuddy\.[a-z]+)'/g)].map((m) => m[1])
  note(hostPaths.includes('/api/workbuddy.credits'), 'host 声明 /api/workbuddy.credits')
  note(hostPaths.includes('/api/workbuddy.status'), 'host 声明 /api/workbuddy.status（模型限流台账）')
  for (const p of hostPaths) {
    note(clientSrc.includes(`'${p}'`), `客户端 bundle 内路径与 host 一致: ${p}`)
  }

  // --- 最近输出速度模块（需求③）的静态接线检查 ---
  note(/const inject = \[[^\]]*'uiConversation'[^\]]*\]/.test(clientSrc), '客户端 inject 声明包含 uiConversation（速度计数据源）')
  note(clientSrc.includes(".target('chat')") || clientSrc.includes('.target("chat")'), '客户端订阅 chat 视图快照（target chat）')
  note(clientSrc.includes('legacy?.partial') || clientSrc.includes('legacy.partial'), '客户端读取 chat 快照的流式 partial')
  note(clientSrc.includes('tok/s'), '速度显示带 tok/s 单位')
  note(clientSrc.includes('estimateTokens'), '包含 token 折算函数（流式期间无精确计数，按字符估算）')
  note(clientSrc.includes('SPEED_WINDOW_MS'), '速度窗口常量存在（滑动窗口口径）')
} catch (e) {
  note(false, `端点路径一致性检查失败: ${e.message}`)
}

console.log(fail.length === 0 ? '\n全部通过 ✓' : `\n${fail.length} 项失败 ✗`)
process.exitCode = fail.length === 0 ? 0 : 1
