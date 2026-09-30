/**
 * @wb-credits/host — WorkBuddy 积分：Host 半边。
 *
 * 为浏览器半边提供一个受 DSH 鉴权保护的只读端点：
 *
 *   GET /api/workbuddy.credits
 *     → {"ok":true,"remain":1576,"used":3924,"size":5500,"accounts":[...],"ts":...}
 *
 *   GET /api/workbuddy.status
 *     → {"ok":true,"rate_limited":[{"model":"...","accounts":2,"reset_at":"...","until":"...","reason":"..."}],"ts":...}
 *
 * 数据来自本机 workbuddy2api 网关的 GET /credits（该端点内部走 realm 感知的
 * 上游计费查询，并自带 TTL 缓存）。网关的 API Key 只存在于 Host 进程内，
 * 绝不会下发到浏览器。
 *
 * 之所以不让浏览器直连网关：一是跨源（DSH 在 18080、网关在 7863）会被 CORS 拦，
 * 二是那会把网关密钥暴露给页面。走 Host 代理两点都避免。
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
 * 查询网关 /credits，归一化成一个浏览器友好的扁平结构。
 *
 * 网关的响应里 accounts 是数组、total 是汇总；这里两个都保留：数组给「按账号
 * 展开」的将来用，扁平的 remain/used/size 让底部那一行不必自己求和。
 *
 * @param options - 已解析的连接参数。
 * @returns 归一化结果；网络或鉴权失败时抛错（由调用方转成 502）。
 */
async function fetchCredits(options) {
	const url = new URL('/credits', options.baseUrl)
	const headers = { accept: 'application/json' }
	if (options.apiKey !== '') headers.authorization = `Bearer ${options.apiKey}`

	const response = await fetch(url, {
		method: 'GET',
		headers,
		signal: AbortSignal.timeout(options.timeoutMs),
	}).catch((cause) => {
		// 最常见的情形是网关容器没起（或 Docker 没运行）：把「连不上」讲清楚，
		// 否则前端只会看到 undici 的 "fetch failed"，无从判断该去启动什么。
		throw new Error(`无法连接网关 ${options.baseUrl}（容器是否在运行？）: ${cause?.message ?? cause}`)
	})

	const text = await response.text()
	if (!response.ok) {
		throw new Error(`gateway /credits responded ${response.status}: ${text.slice(0, 200)}`)
	}

	let body
	try {
		body = JSON.parse(text)
	} catch {
		throw new Error('gateway /credits returned a non-JSON body')
	}

	const total = body.total ?? {}
	const accounts = Array.isArray(body.accounts) ? body.accounts : []

	return {
		ok: true,
		service: body.service ?? 'workbuddy',
		ts: typeof body.ts === 'number' ? body.ts : Math.floor(Date.now() / 1000),
		// 汇总口径与网关一致：只累加查询成功的账号。
		remain: total.remain ?? 0,
		used: total.used ?? 0,
		size: total.size ?? 0,
		accounts: accounts.map((a) => ({
			uid: a.uid ?? '',
			nickname: a.nickname ?? '',
			realm: a.realm ?? '',
			remain: a.remain ?? null,
			used: a.used ?? null,
			size: a.size ?? null,
			ok: a.ok === true,
			error: a.error ?? '',
		})),
	}
}

/**
 * 查询网关 /status，聚合出**模型级**限流台账。
 *
 * 口径（重要）：6004（模型用量超限）触发的是**模型级**独立冷却，台账按账号挂在
 * accounts[].rate_limited_models[] 上（网关 issue #36）。账号级健康指标全绿不代表
 * 模型没被限——503 no_healthy_account 的根因就是它。这里把多账号的行**按模型聚合**：
 * 同一模型取最晚的 reset_at / until（保守口径：任一账号仍在限流就展示最晚恢复时间），
 * accounts 计数说明有几个号还在限流中。
 *
 * @param options - 已解析的连接参数。
 * @returns 归一化结果；网络或鉴权失败时抛错（由调用方转成 502）。
 */
async function fetchStatus(options) {
	const url = new URL('/status', options.baseUrl)
	const headers = { accept: 'application/json' }
	if (options.apiKey !== '') headers.authorization = `Bearer ${options.apiKey}`

	const response = await fetch(url, {
		method: 'GET',
		headers,
		signal: AbortSignal.timeout(options.timeoutMs),
	}).catch((cause) => {
		throw new Error(`无法连接网关 ${options.baseUrl}（容器是否在运行？）: ${cause?.message ?? cause}`)
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

	const accounts = Array.isArray(body.accounts) ? body.accounts : []
	const byModel = new Map()
	for (const acct of accounts) {
		if (!Array.isArray(acct?.rate_limited_models)) continue
		for (const row of acct.rate_limited_models) {
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
		ts: Math.floor(Date.now() / 1000),
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
			'wb-credits: no gateway API key found (set config.apiKey, %s, or config.projectDir) — /credits will answer 401',
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
				payload = await fetchCredits(options)
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
				payload = await fetchStatus(options)
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
