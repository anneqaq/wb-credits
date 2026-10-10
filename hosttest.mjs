// 集成测试：用假 ctx 驱动 host 半边，捕获注册的路由并真正调用它。
//
// 两段式：
//   A. 内置 mock 网关（确定性）：验证「端点注册 → handler 查询网关 → 归一化/聚合」
//      的完整链路，包括多账号限流台账的聚合口径（同模型取最晚 reset_at/until），
//      以及网关不可达时的 502 形态。不依赖真机，可离线跑。
//   B. 真机探测（可选）：对默认网关地址各发一枪，只作 [INFO] 展示，不参与通过/失败。
import http from 'node:http'
import { apply, CREDITS_PATH, STATUS_PATH } from './lib/index.js'

let failures = 0
const note = (ok, msg) => {
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${msg}`)
  if (!ok) failures++
}

// ---------------------------------------------------------------------------
// 假 ctx：捕获全部注册路由，支持按 path 取用与整体撤销。
// ---------------------------------------------------------------------------
const routes = new Map() // path -> route
const effects = []
const effectDisposers = [] // ctx.effect 登记的 disposer（模拟 fiber 登记行为）
const ctx = {
  logger: { warn: (...a) => console.log('[plugin warn]', ...a) },
  // 模拟官方的 ctx.effect(fn, label)：fn 返回 disposer，effect 把它登记到 fiber 上。
  // 有了这层，测试才能验出「注册被 effect 包裹」而不是裸调用。
  effect(fn, label) {
    effects.push(label)
    const dispose = fn()
    effectDisposers.push(() => dispose?.())
    return () => dispose?.()
  },
  connection: {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
  },
}

// ---------------------------------------------------------------------------
// mock 网关：/credits 两账号（一好一坏）、/status 两账号共三个限流行（同模型聚合）。
// ---------------------------------------------------------------------------
const LATER = '2026-01-01T12:00:00Z'
const EARLIER = '2026-01-01T09:30:00Z'
const GATEWAY_STATUS = {
  accounts: [
    {
      uid: 'u1',
      nickname: 'alpha',
      realm: 'cn',
      credits: 1576,
      cooling: false,
      until: '0001-01-01T00:00:00Z',
      disabled: false,
      manual_disabled: false,
      rate_limited_models: [
        { model: 'glm-5.2', until: EARLIER, reset_at: EARLIER, reason: 'model usage limit exceeded' },
        { model: 'deepseek-v4.1', until: LATER, reset_at: LATER, reason: 'model usage limit exceeded' },
      ],
    },
    {
      uid: 'u2',
      nickname: 'beta',
      realm: 'global',
      credits: 420,
      cooling: true,
      until: LATER,
      disabled: false,
      manual_disabled: false,
      rate_limited_models: [
        { model: 'glm-5.2', until: LATER, reset_at: LATER, reason: 'model usage limit exceeded' },
      ],
    },
    {
      // 停用账号：credits 可能是 0 或缺失，插件不得因此崩或算成 NaN。
      uid: 'u3',
      nickname: 'gamma',
      realm: 'cn',
      credits: 0,
      cooling: false,
      disabled: true,
      manual_disabled: false,
    },
  ],
  healthy: 2,
  total: 3,
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock')
  if (url.pathname === '/status') {
    if ((req.headers.authorization ?? '') !== 'Bearer test-key') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(GATEWAY_STATUS))
    return
  }
  // 上游网关**没有** /credits 路由（本地未提交的附加端点）。明确返回 404，
  // 以便「插件不再依赖 /credits」这件事被测试盯住。
  res.writeHead(404)
  res.end('404 page not found')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const mockBase = `http://127.0.0.1:${server.address().port}`

try {
  // --- 注册 ---
  apply(ctx, { baseUrl: mockBase, apiKey: 'test-key', projectDir: 'D:/nonexistent-dir-for-test' })
  note(effects.length === 2, `两个路由都包在 ctx.effect 里（labels: ${effects.join(' | ')}）`)
  note(routes.has(CREDITS_PATH), `注册了 ${CREDITS_PATH}`)
  note(routes.has(STATUS_PATH), `注册了 ${STATUS_PATH}`)

  // --- /credits：积分来自 /status 的 accounts[].credits ---
  {
    const res = await routes.get(CREDITS_PATH).fetch(new Request(`http://x${CREDITS_PATH}`))
    const body = await res.json()
    note(res.status === 200 && body.ok === true, '/credits 返回 200 + ok')
    note(body.remain === 1996, `汇总 = 各账号 credits 之和（1576+420+0=1996，实际 ${body.remain}）`)
    note(Array.isArray(body.accounts) && body.accounts.length === 3, '/credits accounts 数组透传（3 个账号）')
    note(body.accounts[0]?.credits === 1576, 'accounts[0].credits 透传')
    note(body.accounts[0]?.realm === 'cn', 'accounts[0] 带 realm')
    note(body.accounts[1]?.cooling === true, '冷却中账号带出 cooling 标记')
    note(body.accounts[2]?.disabled === true, '停用账号带出 disabled 标记')
    note(body.total?.accounts === 3 && body.total?.cooling === 1 && body.total?.disabled === 1,
      `total 汇总账号数/冷却数/停用数（=${body.total?.accounts}/${body.total?.cooling}/${body.total?.disabled}）`)
    note(body.accounts.every((a) => typeof a.credits === 'number'), '停用账号 credits=0 也保留为数字（不塌成 undefined）')
  }

  // --- /status：模型级限流聚合 ---
  {
    const res = await routes.get(STATUS_PATH).fetch(new Request(`http://x${STATUS_PATH}`))
    const body = await res.json()
    note(res.status === 200 && body.ok === true, '/status 返回 200 + ok')
    const rows = body.rate_limited ?? []
    note(Array.isArray(rows) && rows.length === 2, `聚合后 2 个模型（=${rows.map((r) => r.model).join(',')}）`)
    const glm = rows.find((r) => r.model === 'glm-5.2')
    note(!!glm, 'glm-5.2 行存在（两个账号都在限流，聚合成一行）')
    note(glm?.accounts === 2, 'glm-5.2 accounts=2（受影响账号计数）')
    note(glm?.reset_at === LATER, 'glm-5.2 reset_at 取最晚（u2 的 12:00，而非 u1 的 09:30）')
    note(glm?.until === LATER, 'glm-5.2 until 同样取最晚')
    note(typeof glm?.reason === 'string' && glm.reason !== '', 'glm-5.2 reason 透传')
    const ds = rows.find((r) => r.model === 'deepseek-v4.1')
    note(ds?.accounts === 1 && ds?.reset_at === LATER, 'deepseek-v4.1 单账号行保持原样')
    note(rows[0].model < rows[1].model, '台账行按模型名排序（稳定输出）')
    note(!rows.some((r) => r.model === undefined), '无 rate_limited_models 的账号不产生空行（omitempty 常态）')
  }

  // --- 两个端点共享一次并发请求（合并，不是缓存陈旧值） ---
  {
    const [a, b] = await Promise.all([
      routes.get(CREDITS_PATH).fetch(new Request(`http://x${CREDITS_PATH}`)),
      routes.get(STATUS_PATH).fetch(new Request(`http://x${STATUS_PATH}`)),
    ])
    note(a.status === 200 && b.status === 200, '并发调用两个端点都成功（共享同一次 /status）')
  }

  // --- HEAD 探活 ---
  {
    const res = await routes.get(STATUS_PATH).fetch(new Request(`http://x${STATUS_PATH}`, { method: 'HEAD' }))
    note(res.status === 200, 'HEAD /status 返回 200（探活）')
  }

  // --- 鉴权失败 → 502 带原因 ---
  {
    apply(ctx, { baseUrl: mockBase, apiKey: 'wrong-key', projectDir: 'D:/nonexistent-dir-for-test' })
    const res = await routes.get(STATUS_PATH).fetch(new Request(`http://x${STATUS_PATH}`))
    const body = await res.json()
    note(res.status === 502 && body.ok === false, '网关 401 → 502 + ok:false（错误不吞）')
    note(typeof body.error === 'string' && body.error.includes('401'), '错误信息带上游状态码')
    note(Array.isArray(body.rate_limited) && body.rate_limited.length === 0, '失败响应也带空 rate_limited（前端可安全降级）')
  }

  // --- 网关不可达 → 502 带原因 ---
  {
    const deadBase = 'http://127.0.0.1:1' // 保留地址，必然连接失败
    apply(ctx, { baseUrl: deadBase, apiKey: 'k', projectDir: 'D:/nonexistent-dir-for-test' })
    const res = await routes.get(CREDITS_PATH).fetch(new Request(`http://x${CREDITS_PATH}`))
    const body = await res.json()
    note(res.status === 502 && body.ok === false, '网关不可达 → 502 + ok:false')
    note(body.error.includes('无法连接网关'), '错误信息说明「连不上」而非裸 fetch failed')
  }

  // --- 卸载清理：走 ctx.effect 登记的 disposer（模拟 fiber 卸载），不得残留路由 ---
  for (const dispose of effectDisposers) dispose()
  note(routes.size === 0, `卸载后路由全部撤销（disposer 生效，routes=${routes.size}）`)

  // --- 真机探测（可选，不参与判定） ---
  // WB_CREDITS_BASE_URL 可指向真实网关（默认本机 7863）；密钥仍按
  // config.apiKey → apiKeyEnv → projectDir 的顺序解析。
  if (process.env.WB_CREDITS_LIVE !== '0') {
    const liveBase = process.env.WB_CREDITS_BASE_URL ?? 'http://127.0.0.1:7863'
    const liveKey = process.env.WORKBUDDY_API_KEY ?? ''
    const liveProject = process.env.WB_CREDITS_PROJECT_DIR ?? 'D:/app/work-deepseek/workbuddy2api'
    apply(ctx, { baseUrl: liveBase, apiKey: liveKey, projectDir: liveProject })
    for (const [label, path] of [['credits', CREDITS_PATH], ['status', STATUS_PATH]]) {
      const route = routes.get(path)
      if (!route) continue
      try {
        const res = await route.fetch(new Request(`http://127.0.0.1:18080${path}`))
        const body = await res.json().catch(() => null)
        const brief = body?.ok === true
          ? (label === 'credits'
            ? `remain=${body.remain} accounts=${body.total?.accounts} cooling=${body.total?.cooling} disabled=${body.total?.disabled}`
            : `rate_limited=${body.rate_limited?.length}`)
          : JSON.stringify(body).slice(0, 200)
        console.log(`[INFO] 真机 ${label} @ ${liveBase}: HTTP ${res.status} ${brief}`)
      } catch (e) {
        console.log(`[INFO] 真机 ${label} 不可达（网关未启动则属预期）: ${e.message}`)
      }
    }
  }
} finally {
  server.close()
}

console.log(failures === 0 ? '\n全部通过 ✓' : `\n${failures} 项失败 ✗`)
process.exitCode = failures === 0 ? 0 : 1
