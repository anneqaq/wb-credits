/**
 * @wb-credits/host — WorkBuddy 积分：Host 半边。
 *
 * 为浏览器半边提供一个受 DSH 鉴权保护的只读端点：
 *
 *   GET /api/workbuddy.credits
 *     → {"ok":true,"remain":5755,"accounts":[...],"total":{...},"ts":...}
 *
 *   GET /api/workbuddy.status
 *     → {"ok":true,"rate_limited":[{"model":"...","accounts":2,"reset_at":"...","until":"...","reason":"..."}],"ts":...}
 *
 * 两个端点都以网关的 **GET /status** 为单一数据源：剩余积分在各账号的
 * `credits` 字段，模型级限流台账在各账号的 `rate_limited_models[]`。
 * 网关的 API Key 只存在于 Host 进程内，绝不会下发到浏览器。
 *
 * 之所以不让浏览器直连网关：一是跨源会被 CORS 拦，二是那会把网关密钥暴露给页面。
 * 走 Host 代理两点都避免。
 *
 * @module wb-credits/host
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'wb-credits'

/**
 * 依赖 connection 服务（提供浏览器可到达的精确 fetch 路由表）。
 * 没有它插件保持 pending，不会以半残状态启动。
 */
export const inject = ['connection']

/** 浏览器端点路径，改动需同步客户端半边。 */
export const CREDITS_PATH = '/api/workbuddy.credits'
/** 浏览器端点路径：网关 /status 的代理（模型限流台账），改动需同步客户端半边。 */
export const STATUS_PATH = '/api/workbuddy.status'

/** 默认的网关连接参数。 */
const DEFAULT_BASE_URL = 'http://127.0.0.1:7863'
/**
 * 默认的网关项目目录：**故意留空**。
 *
 * 这里不猜任何机器上的绝对路径：它会随安装位置变化，也会把本机目录结构
 * 带进版本库。需要从网关的 config.json 兜底读密钥时，用 `config.projectDir`
 * 或环境变量 `WB_CREDITS_PROJECT_DIR` 指定。
 */
const DEFAULT_PROJECT_DIR = ''
/** 默认从哪个环境变量读密钥（与 DSH 各 provider 的 apiKeyEnv 同惯例）。 */
const DEFAULT_API_KEY_ENV = 'WORKBUDDY_API_KEY'
/** 默认的网关查询超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 30000

/**
 * 进行中的 /status 请求。用于**并发合并**：积分行（30s）与限流徽标（60s）各自
 * 轮询，页面加载时几乎同时首发；并发期间共享同一次上游请求。
 *
 * 刻意**不缓存结果**：下一次轮询总是取新值，失败也不会被缓存吞掉
 * （若缓存成功结果，改配置换密钥后的头几秒会返回旧数据）。
 */
let inflight = null

/**
 * 从网关的 config.json 读取 api_key。
 *
 * 直接读文件而不是要求把密钥写进 patch 配置：patch 文件不该出现明文密钥，
 * 而网关自己的 config.json 本来就是密钥的存放处（权限受控、不入库）。
 *
 * @param projectDir - 网关项目目录；空串直接返回空串（不做任何路径猜测）。
 * @returns api_key；读不到或为空时返回空串。
 */
function readGatewayKey(projectDir) {
	if (projectDir === '') return ''
	try {
		const raw = readFileSync(join(projectDir, 'config.json'), 'utf8')
		const cfg = JSON.parse(raw)
		return typeof cfg.api_key === 'string' ? cfg.api_key : ''
	} catch {
		return ''
	}
}

/**
 * 按优先级解析网关密钥。
 *
 * 顺序：显式 `config.apiKey` → `config.apiKeyEnv` 指向的环境变量 → 网关
 * `config.json`（仅在给了 `projectDir` 时）。密钥只留在 Host 进程内存里，
 * 不下发到浏览器；任一来源都没有时返回空串，由调用方决定如何告警。
 *
 * @param options - 已解析的连接参数。
 * @returns 密钥；三个来源都拿不到时为空串。
 */
function resolveApiKey(options) {
	if (options.apiKey !== '') return options.apiKey
	const fromEnv = options.apiKeyEnv === '' ? undefined : process.env[options.apiKeyEnv]
	if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
	return readGatewayKey(options.projectDir)
}

/**
 * 查询网关 /status 并归一化。
 *
 * **单一数据源**：剩余积分（`accounts[].credits`）与限流台账
 * （`accounts[].rate_limited_models[]`）都在 /status 里。
 *
 * 旧版本另有一个 /credits 汇总端点，但它只是本地未提交的附加实现，
 * **上游网关没有这个路由**（远端返回 404 not found）——所以不再依赖它。
 * /status 是网关的既有端点，新旧版本都有。
 *
 * @param options - 已解析的连接参数。
 * @returns 归一化结果；网络或鉴权失败时抛错（由调用方转成 502）。
 */
async function fetchGatewayStatus(options) {
	if (inflight !== null) return inflight
	inflight = requestGatewayStatus(options).finally(() => {
		inflight = null
	})
	return inflight
}

/**
 * 真正发起 /status 请求并归一化（由 {@link fetchGatewayStatus} 做并发合并）。
 *
 * @param options - 已解析的连接参数。
 * @returns 归一化结果。
 */
async function requestGatewayStatus(options) {
	const url = new URL('/status', options.baseUrl)
	const headers = { accept: 'application/json' }
	if (options.apiKey !== '') headers.authorization = `Bearer ${options.apiKey}`

	const response = await fetch(url, {
		method: 'GET',
		headers,
		signal: AbortSignal.timeout(options.timeoutMs),
	}).catch((cause) => {
		// 最常见的情形是网关没起或公网不通：把「连不上」讲清楚，
		// 否则前端只会看到 undici 的 "fetch failed"，无从判断该去启动什么。
		throw new Error(`无法连接网关 ${options.baseUrl}（网关是否在运行？）: ${cause?.message ?? cause}`)
	})

	const text = await response.text()
	if (!response.ok) {
		throw new Error(`gateway /status responded ${response.status}: ${text.slice(0, 200)}`)
	}

	let body
	try {
		body = JSON.parse(text)
	} catch {
		throw new Error('gateway /status returned a non-JSON body')
	}

	const raw = Array.isArray(body.accounts) ? body.accounts : []
	const accounts = raw.map((a) => ({
		uid: a?.uid ?? '',
		nickname: a?.nickname ?? '',
		realm: a?.realm ?? '',
		// credits 是账号当前剩余积分；缺失/非数字一律记 null，由前端显示 "—"。
		credits: typeof a?.credits === 'number' ? a.credits : null,
		// 账号级状态：cooling=冷却中（until 为截止墙钟）、disabled=停用。
		cooling: a?.cooling === true,
		until: typeof a?.until === 'string' ? a.until : '',
		disabled: a?.disabled === true,
		manualDisabled: a?.manual_disabled === true,
		rateLimitedModels: Array.isArray(a?.rate_limited_models) ? a.rate_limited_models : [],
	}))

	const payload = {
		ts: Math.floor(Date.now() / 1000),
		accounts,
		total: typeof body.total === 'number' ? body.total : accounts.length,
		healthy: typeof body.healthy === 'number' ? body.healthy : null,
	}
	return payload
}

/**
 * 由 /status 归一化结果构造「积分」视图。
 *
 * 汇总口径：只累加能解析出数字的 credits（缺失按 0 计，不当作负数）。
 * 账号级状态随行带出，供悬停明细标注冷却/停用。
 *
 * @param status - fetchGatewayStatus 的结果。
 * @returns 浏览器友好的积分结构。
 */
function buildCreditsView(status) {
	const remain = status.accounts.reduce((sum, a) => sum + (typeof a.credits === 'number' ? a.credits : 0), 0)
	return {
		ok: true,
		service: 'workbuddy',
		ts: status.ts,
		remain,
		accounts: status.accounts.map((a) => ({
			uid: a.uid,
			nickname: a.nickname,
			realm: a.realm,
			credits: a.credits,
			cooling: a.cooling,
			until: a.until,
			disabled: a.disabled,
		})),
		total: {
			accounts: status.accounts.length,
			healthy: status.healthy,
			disabled: status.accounts.filter((a) => a.disabled).length,
			cooling: status.accounts.filter((a) => a.cooling).length,
		},
	}
}

/**
 * 由 /status 归一化结果聚合出**模型级**限流台账（需求①）。
 *
 * 口径（重要）：6004（模型用量超限）触发的是**模型级**独立冷却，台账按账号挂在
 * accounts[].rate_limited_models[] 上（网关 issue #36），该字段带 omitempty —
 * 没有限流时整个键都不出现，因此空数组是常态而非异常。账号级健康指标全绿不代表
 * 模型没被限——503 no_healthy_account 的根因就是它。这里把多账号的行**按模型聚合**：
 * 同一模型取最晚的 reset_at / until（保守口径：任一账号仍在限流就展示最晚恢复时间），
 * accounts 计数说明有几个号还在限流中。
 *
 * @param status - fetchGatewayStatus 的结果。
 * @returns 浏览器友好的限流结构。
 */
function buildLimitView(status) {
	const byModel = new Map()
	for (const acct of status.accounts) {
		for (const row of acct.rateLimitedModels) {
			if (typeof row?.model !== 'string' || row.model === '') continue
			const entry = byModel.get(row.model) ?? {
				model: row.model,
				accounts: 0,
				reset_at: '',
				until: '',
				reason: '',
			}
			entry.accounts += 1
			// reset_at：上游 6004 文案里的「将在 X 重置」权威墙钟，取最晚者。
			const resetMs = Date.parse(row.reset_at ?? '')
			if (Number.isFinite(resetMs) && resetMs > (Date.parse(entry.reset_at) || 0)) entry.reset_at = row.reset_at
			// until：网关侧冷却截止（可能被 soft_rate_max 截断），同样取最晚者。
			const untilMs = Date.parse(row.until ?? '')
			if (Number.isFinite(untilMs) && untilMs > (Date.parse(entry.until) || 0)) entry.until = row.until
			if (entry.reason === '' && typeof row.reason === 'string' && row.reason !== '') entry.reason = row.reason
			byModel.set(row.model, entry)
		}
	}

	const rate_limited = [...byModel.values()].sort((a, b) =>
		a.model < b.model ? -1 : a.model > b.model ? 1 : 0,
	)
	return {
		ok: true,
		ts: status.ts,
		rate_limited,
	}
}

/**
 * 注册 Host 端点。注册是插件 fiber 上的 effect，卸载即撤销路由。
 *
 * @param ctx - 携带 connection 的 Host 上下文。
 * @param config - patch 层传入的可选覆盖（baseUrl / projectDir / apiKey / timeoutMs）。
 */
export function apply(ctx, config = {}) {
	const options = {
		baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
		projectDir: config.projectDir ?? process.env.WB_CREDITS_PROJECT_DIR ?? DEFAULT_PROJECT_DIR,
		apiKey: config.apiKey ?? '',
		apiKeyEnv: config.apiKeyEnv ?? DEFAULT_API_KEY_ENV,
		timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
	}
	// 未显式配置密钥时，依次回落：环境变量 → 网关自己的 config.json。
	if (options.apiKey === '') options.apiKey = resolveApiKey(options)
	// 三个来源都拿不到时明确告警：否则前端只会看到网关 401，无从判断是密钥没配。
	if (options.apiKey === '') {
		ctx.logger?.warn?.(
			'wb-credits: no gateway API key found (set config.apiKey, %s, or config.projectDir) — /status will answer 401',
			options.apiKeyEnv,
		)
	}

	const connection = Reflect.get(ctx, 'connection')
	if (connection === undefined || connection.fetch === undefined) {
		throw new Error('wb-credits: connection.fetch is unavailable; the Host cannot serve the credits endpoint')
	}

	// 注册必须包在 ctx.effect 里：register 返回 disposer，由 fiber 在插件卸载/重建时
	// 调用，路由才会随插件一起撤销。裸调用会让旧路由残留，重挂载时 connection 报
	// duplicate route 而导致插件挂载失败（官方各插件均用此形态）。
	ctx.effect(() => connection.fetch.register({
		path: CREDITS_PATH,
		methods: ['GET', 'HEAD'],
		requestBody: 'buffered',
		fetch: async (request) => {
			let payload
			try {
				payload = buildCreditsView(await fetchGatewayStatus(options))
			} catch (error) {
				// 502 而不是 500：失败发生在被代理的上游，不是本插件自身。
				// 把原因原样带回前端，便于直接看出是网关没起还是密钥不对。
				const message = error instanceof Error ? error.message : String(error)
				ctx.logger?.warn?.('wb-credits: %s', message)
				return Response.json(
					{ ok: false, error: message },
					{ status: 502, headers: { 'cache-control': 'no-store' } },
				)
			}

			if (request.method === 'HEAD') {
				return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
			}
			return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
		},
	}), 'wb-credits: host credits route')

	// 模型限流台账端点：同样包在 ctx.effect 里随插件卸载。
	ctx.effect(() => connection.fetch.register({
		path: STATUS_PATH,
		methods: ['GET', 'HEAD'],
		requestBody: 'buffered',
		fetch: async (request) => {
			let payload
			try {
				payload = buildLimitView(await fetchGatewayStatus(options))
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				ctx.logger?.warn?.('wb-credits: %s', message)
				return Response.json(
					{ ok: false, error: message, rate_limited: [] },
					{ status: 502, headers: { 'cache-control': 'no-store' } },
				)
			}

			if (request.method === 'HEAD') {
				return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } })
			}
			return Response.json(payload, { headers: { 'cache-control': 'no-store' } })
		},
	}), 'wb-credits: host status route')
}
