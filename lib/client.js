/**
 * @wb-credits/client — WorkBuddy 积分：浏览器半边。
 *
 * 在对话输入卡片下方（slot `conversation.composer.dock`）渲染一行积分信息：
 *
 *  1. 剩余总积分 + 账号数（轮询 30s）。网关按账号汇报剩余积分，没有「总额/已用」口径，
 *     所以这里只汇总剩余、并说明参与汇总的账号数与异常账号数。
 *  2. **模型限流徽标**（轮询 60s）：有模型被 6004 限流时在积分行左侧显示，
 *     悬停展开每个被限模型的账号数与恢复时间（reset_at 为上游权威重置墙钟，
 *     网关自身的 until 可能被 soft_rate_max 截断，仅供对照）。
 *  3. **悬停账号积分明细**：鼠标放到积分行上，title 展开各账号的剩余积分，
 *     并标注冷却中 / 已停用的账号（cooling、disabled）。
 *  4. **最近输出速度**：流式期间显示「最近 8s 窗口」的估算 tok/s（字符折算），
 *     反映当前模型此刻的出字快慢——与 DSH 自带的整轮平均互补，换慢模型不拖尾。
 *     空闲时隐藏。
 *
 * 数据来自 Host 半边的受鉴权端点 `/api/workbuddy.credits` 与 `/api/workbuddy.status`；
 * 浏览器不直连网关（跨源 + 会暴露网关密钥）。
 *
 * 这是 __ModuleLoader__ 工厂格式，不是 ESM：与随包交付的客户端插件同构，
 * 因此无需任何构建工具链。
 */
window.__ModuleLoader__.load({
	id: 'wb-credits',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')

		/** Host 端点路径，必须与 lib/index.js 的 CREDITS_PATH / STATUS_PATH 一致。 */
		const CREDITS_PATH = '/api/workbuddy.credits'
		const STATUS_PATH = '/api/workbuddy.status'
		/** 轮询间隔：积分变化慢，30s 足够新鲜；Host 与网关两层都有缓存兜底。 */
		const POLL_MS = 30000
		/** 限流台账轮询间隔：台账变化更慢（模型级冷却以小时计），60s 足够。 */
		const LIMIT_POLL_MS = 60000
		/** 最近输出速度的估算窗口（毫秒）：窗口越短越"瞬时"，抖动也越大。8s 够稳又够新。 */
		const SPEED_WINDOW_MS = 8000

		/**
	 * 解析 Host 基址。与随包插件同口径：页面 origin 在 file:// 等场景下会是
		 * "null"，此时退回一个只用于拼相对路径的伪 origin。
		 * @returns Host 基址 origin。
		 */
		function hostBase() {
			const origin = globalThis.location?.origin
			return origin !== undefined && origin !== 'null' ? origin : 'http://dsh.internal'
		}

		/**
		 * 取一次 Host 端点的 JSON。
		 * @param path - 端点路径。
		 * @param signal - 卸载时用于中止请求。
		 * @returns 解析后的 JSON 对象。
		 */
		async function loadJson(path, signal) {
			const url = new URL(path, hostBase())
			const response = await fetch(url, { headers: { accept: 'application/json' }, signal })
			// 先取文本再尝试解析：路由层的拒绝（如 400/404）返回纯文本，
			// 只调用 response.json() 会抛解析错，把真正原因吞掉。
			const text = await response.text()
			let body = null
			try {
				body = JSON.parse(text)
			} catch {
				body = null
			}
			if (!response.ok || body?.ok !== true) {
				const detail = body?.error ?? (text.trim() === '' ? '(空响应体)' : text.trim().slice(0, 200))
				throw new Error(`HTTP ${response.status}${detail ? ` — ${detail}` : ''}`)
			}
			return body
		}

		/** 千分位。积分是整数，不需要小数。 */
		function fmt(n) {
			return typeof n === 'number' ? n.toLocaleString('en-US') : '—'
		}

		/**
		 * 把网关的 RFC3339 时间串格式化成当地「时:分」。
		 * @param iso - RFC3339 时间串（如 2026-09-30T17:38:28.845+08:00）。
		 * @returns 形如 "17:38"；解析不出来时返回空串（调用方据此不渲染）。
		 */
		function clockOf(iso) {
			if (typeof iso !== 'string' || iso === '') return ''
			const ms = Date.parse(iso)
			if (!Number.isFinite(ms)) return ''
			const d = new Date(ms)
			return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
		}

		/**
		 * 把 ISO 时间渲染成「HH:MM」本地短时间；跨天再带「明天/今天」前缀。
		 * 解析失败返回原文（保证信息不丢）。
		 * @param iso - ISO 8601 时间串。
		 * @returns 展示串。
		 */
		function fmtTime(iso) {
			const ms = Date.parse(iso ?? '')
			if (!Number.isFinite(ms)) return iso || '—'
			const d = new Date(ms)
			const now = new Date()
			const sameDay = d.toDateString() === now.toDateString()
			const hh = String(d.getHours()).padStart(2, '0')
			const mm = String(d.getMinutes()).padStart(2, '0')
			return `${sameDay ? '今天' : '明天'} ${hh}:${mm}`
		}

		/**
		 * 距目标的剩余时长短文案（如 "2h13m" / "45m" / "<1m"）。
		 * @param iso - ISO 8601 时间串。
		 * @returns 展示串；已过期为空串。
		 */
		function untilText(iso) {
			const ms = Date.parse(iso ?? '')
			if (!Number.isFinite(ms)) return ''
			const remainMs = ms - Date.now()
			if (remainMs <= 0) return ''
			const minutes = Math.ceil(remainMs / 60000)
			if (minutes < 60) return `${minutes}m`
			const h = Math.floor(minutes / 60)
			const m = minutes % 60
			return m === 0 ? `${h}h` : `${h}h${m}m`
		}

		const S = {
			wrap: {
				display: 'flex',
				alignItems: 'center',
				gap: '10px',
				flexWrap: 'wrap',
				padding: '2px 4px 0',
				fontSize: '11px',
				lineHeight: '16px',
				color: 'var(--dsh-text-secondary, #8b8b8b)',
				userSelect: 'none',
			},
			label: { opacity: 0.75 },
			value: { fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: 'var(--dsh-text-primary, #d4d4d4)' },
			sep: { opacity: 0.35 },
			muted: { opacity: 0.6 },
			err: { color: '#e5534b' },
			// 限流徽标：琥珀底色小圆片，悬停由原生 title 展开明细。
			limit: {
				display: 'inline-flex',
				alignItems: 'center',
				gap: '4px',
				padding: '0 7px',
				borderRadius: '8px',
				background: 'rgba(210, 153, 34, 0.18)',
				color: '#d29922',
				fontWeight: 600,
				whiteSpace: 'nowrap',
			},
			limitDot: {
				width: '6px',
				height: '6px',
				borderRadius: '3px',
				background: '#d29922',
				display: 'inline-block',
			},
		}

		/**
		 * 构建积分行的悬停 title：各账号池的余额明细（需求②）。
		 *
		 * 用多行文本走原生 title，零依赖、零布局成本；账号排序保持网关返回序。
		 * @param data - Host /credits 的归一化响应。
		 * @returns title 文本；无账号数据时返回 undefined（不显示）。
		 */
		function accountsTitle(data) {
			const list = Array.isArray(data?.accounts) ? data.accounts : []
			if (list.length === 0) return undefined
			const lines = ['账号池积分明细：']
			for (const a of list) {
				const name = a.nickname || a.uid || '(未知名)'
				const realm = a.realm ? `[${a.realm}]` : ''
				// 账号级状态取自网关：disabled=停用，cooling=冷却中（until 为截止墙钟）。
				const state = a.disabled ? '已停用' : a.cooling ? '冷却中' : ''
				const at = clockOf(a.until)
				const note = state === '' ? '' : `（${state}${at === '' ? '' : `，至 ${at}`}）`
				lines.push(`• ${name}${realm} — 剩余 ${fmt(a.credits)}${note}`)
			}
			const t = data?.total ?? {}
			const bits = [`共 ${fmt(typeof t.accounts === 'number' ? t.accounts : list.length)} 个账号`]
			if (typeof t.healthy === 'number') bits.push(`健康 ${t.healthy}`)
			lines.push(bits.join('，'))
			lines.push(`（刷新于 ${new Date((data.ts ?? 0) * 1000).toLocaleTimeString()}，30s 自动刷新）`)
			return lines.join('\n')
		}

		/**
		 * 估算一段文本的 token 数。
		 *
		 * 流式过程中拿不到精确 token 计数（usage 只在收尾帧出现），只能按字符折算：
		 * CJK 字符大多 1 字 ≈ 1 token，拉丁词平均 ≈ 4 字符/词 ≈ 1.3 token/词（含标点）。
		 * 系数用于「最近速度」的相对感知足够；精确值以 DSH 自带的整轮平均为准。
		 * @param text - 任意文本。
		 * @returns 估算 token 数（非负整数）。
		 */
		function estimateTokens(text) {
			if (typeof text !== 'string' || text === '') return 0
			let cjk = 0
			let other = 0
			for (const ch of text) {
				if (ch.charCodeAt(0) > 0x2e7f) cjk++ // CJK 统一表意区及之后
				else other++
			}
			return Math.max(0, Math.round(cjk + (other / 4) * 1.3))
		}

		/**
		 * 从流式 partial 的 blocks 里取**输出相关**的累计字符数。
		 *
		 * 只计 text + reasoning + tool-call 参数：三者都由模型逐 token 生成、都反映
		 * 输出速度。可见文本与推理速度可能不同（thinking 模型的推理段更快），但混计
		 * 的窗口速度仍能如实反映「当前模型此刻的出字快慢」。
		 * @param partial - chat 快照的 legacy.partial（{turn, step, blocks}）。
		 * @returns 累计字符数。
		 */
		function partialChars(partial) {
			let total = 0
			for (const block of partial?.blocks ?? []) {
				if (block.kind === 'text' || block.kind === 'reasoning') total += block.text.length
				else if (block.kind === 'tool-call') total += block.argsRaw.length
			}
			return total
		}

		/**
		 * 最近输出速度表（需求③）：显示「最近 8s 窗口」的估算 tok/s，而不是 DSH 自带
		 * 的整轮平均值——换慢模型后旧平均值会长期拖累显示，这里看的是"此刻"。
		 *
		 * 工作方式：订阅当前会话的 chat 视图快照（`uiConversation.binding(sid).target('chat')`）。
		 * 快照的 `legacy.partial` 在流式期间随 animation-frame 实时更新（携带累积的
		 * text/reasoning/tool-call blocks）。每次 partial 引用变化：把「当前估算 token 数 −
		 * 上次快照的 token 数」作为增量计入样本（时间戳 = now，天然落在动画帧节奏上）；
		 * 只保留窗口内的样本。显示 = 窗口内 token 增量 ÷ 窗口实际时长；窗口内无增量
		 * （或 partial 已消失、即本轮输出结束）→ 显示 "—" 并清空样本。
		 *
		 * 精度口径：token 数是字符折算的**估算值**（CJK 1 字 ≈ 1 token、拉丁 ≈ 5.2
		 * 字符/token）；换模型后它反映的是新模型的实时速度，不受旧平均拖累。
		 * @param props - chatSource：会话 chat 视图的可订阅源（getSnapshot/subscribe）。
		 */
		function SpeedMeter({ chatSource }) {
			const [display, setDisplay] = react.useState('—')
			// 用 ref 存可变计量状态（样本、上次 token 基线），避免每次流式更新都重建 effect。
			const meterRef = react.useRef({ samples: [], lastTokens: 0, lastTurnStep: '' })

			react.useEffect(() => {
				if (chatSource === undefined) return undefined
				let alive = true
				let timer = null

				// 1s 心跳：即使流式暂停也持续老化样本，窗口是滑动的时间窗而非事件窗。
				timer = setInterval(() => {
					if (!alive) return
					const meter = meterRef.current
					const now = Date.now()
					meter.samples = meter.samples.filter((s) => now - s.t <= SPEED_WINDOW_MS)
					const span = meter.samples.length > 0 ? Math.max(500, now - meter.samples[0].t) : 0
					const tokens = meter.samples.reduce((sum, s) => sum + s.tokens, 0)
					if (meter.samples.length === 0 || span <= 0 || tokens <= 0) {
						setDisplay((prev) => (prev === '—' ? prev : '—'))
						return
					}
					setDisplay(`${Math.round(tokens / (span / 1000))}`)
				}, 1000)

				// 快照订阅：partial 变化时把增量记为样本。partial 是块累积的（blocks 引用
				// 每次更新都换新），用 token 基线做差而不是直接数块。
				const unsubscribe = chatSource.subscribe(() => {
					if (!alive) return
					const snapshot = chatSource.getSnapshot()
					const partial = snapshot?.legacy?.partial ?? null
					const meter = meterRef.current
					const now = Date.now()

					if (partial === null) {
						// 无流式输出：清基线与样本（下一轮从零开始）。
						meter.lastTokens = 0
						meter.lastTurnStep = ''
						meter.samples = []
						return
					}

					const turnStep = `${partial.turn}:${partial.step}`
					if (turnStep !== meter.lastTurnStep) {
						// 新一轮输出：重置基线，本轮从零计量。
						meter.lastTurnStep = turnStep
						meter.lastTokens = 0
					}

					const tokens = estimateTokensFromBlocks(partial.blocks)
					const delta = tokens - meter.lastTokens
					if (delta > 0) {
						meter.samples.push({ t: now, tokens: delta })
						meter.lastTokens = tokens
					} else if (tokens < meter.lastTokens) {
						// 内容被重置（重试/重写）：回退基线，不计负增量。
						meter.lastTokens = tokens
					}
					// 淘汰窗口外样本（与心跳同一逻辑，事件驱动的更新更及时）。
					meter.samples = meter.samples.filter((s) => now - s.t <= SPEED_WINDOW_MS)
				})

				return () => {
					alive = false
					if (timer !== null) clearInterval(timer)
					unsubscribe()
				}
			}, [chatSource])

			if (chatSource === undefined || display === '—') return null
			return react.createElement(
				'span',
				{
					key: 'speed',
					style: S.muted,
					title: '最近输出速度（估算）：最近 8 秒窗口内的输出 token 折算速率，反映当前模型此刻的出字快慢。精确的整轮平均值见消息卡片的统计。',
				},
				`输出 ${display} tok/s`,
			)
		}

		/**
		 * 估算 partial blocks 的 token 数（estimateTokens 的多块版本）。
		 * @param blocks - 助手消息的 blocks。
		 * @returns 估算 token 数。
		 */
		function estimateTokensFromBlocks(blocks) {
			let text = ''
			for (const block of blocks ?? []) {
				if (block.kind === 'text' || block.kind === 'reasoning') text += block.text
				else if (block.kind === 'tool-call') text += block.argsRaw
			}
			return estimateTokens(text)
		}

		/**
		 * 模型限流徽标（需求①）。
		 *
		 * 独立轮询（60s）：限流以小时计，不必跟积分一起 30s 刷新；失败静默降级
		 * （保持上次结果 + 灰点），不与积分行的错误展示互相干扰。
		 */
		function ModelLimitBadge() {
			const [state, setState] = react.useState({ data: null, error: '' })

			react.useEffect(() => {
				let alive = true
				let timer = null
				const controller = new AbortController()

				const tick = async () => {
					try {
						const data = await loadJson(STATUS_PATH, controller.signal)
						if (alive) setState({ data, error: '' })
					} catch (error) {
						if (!alive) return
						const message = error instanceof Error ? error.message : String(error)
						setState((prev) => ({ data: prev.data, error: message }))
					}
				}

				tick()
				timer = setInterval(tick, LIMIT_POLL_MS)
				return () => {
					alive = false
					if (timer !== null) clearInterval(timer)
					controller.abort()
				}
			}, [])

			const rows = Array.isArray(state.data?.rate_limited) ? state.data.rate_limited : []
			// 客户端再做一道「还没恢复」过滤：Host 轮询间隙里模型可能刚好解封。
			const active = rows.filter((r) => untilText(r.reset_at || r.until) !== '' || Date.parse(r.reset_at ?? '') > Date.now())
			if (active.length === 0 && state.error === '') return null
			if (active.length === 0) {
				// 台账端点异常但积分正常：给一个不刺眼的提示点，悬停可看原因。
				return react.createElement(
					'span',
					{ key: 'limit-err', style: { ...S.limit, background: 'transparent', opacity: 0.5 }, title: `限流状态不可用：${state.error}` },
					react.createElement('span', { style: { ...S.limitDot, opacity: 0.4 } }),
					'限流?',
				)
			}

			// 明细：每模型一行，账号数 + 上游权威重置时间（+ 网关冷却截止）。
			const lines = ['模型限流中（6004 用量超限）：']
			for (const r of active) {
				const bits = [`${r.accounts} 个账号`, `上游重置 ${fmtTime(r.reset_at)}`]
				const remain = untilText(r.reset_at || r.until)
				if (remain !== '') bits.push(`约 ${remain} 后恢复`)
				lines.push(`• ${r.model} — ${bits.join('，')}`)
			}
			lines.push('切到同池其他模型可立即恢复使用。')

			return react.createElement(
				'span',
				{ key: 'limit', style: S.limit, title: lines.join('\n') },
				react.createElement('span', { style: S.limitDot }),
				`限流 ${active.length}`,
			)
		}

		/**
		 * 底部积分行。
		 *
		 * 只读不写：这是纯展示，不参与任何模型请求，也不改变 agent 行为。
		 * @param props - slot 注入面；chatSource 由 apply 的 inject 工厂按会话提供。
		 */
		function CreditsDock(props) {
			const [state, setState] = react.useState({ status: 'loading', data: null, error: '' })

			react.useEffect(() => {
				let alive = true
				let timer = null
				const controller = new AbortController()

				const tick = async () => {
					try {
						const data = await loadJson(CREDITS_PATH, controller.signal)
						if (alive) setState({ status: 'ready', data, error: '' })
					} catch (error) {
						if (!alive) return
						const message = error instanceof Error ? error.message : String(error)
						setState((prev) => ({ status: prev.data ? 'ready' : 'error', data: prev.data, error: message }))
					}
				}

				tick()
				timer = setInterval(tick, POLL_MS)
				return () => {
					alive = false
					if (timer !== null) clearInterval(timer)
					controller.abort()
				}
			}, [])

			const children = []
			// 限流徽标在最左：异常状态优先于余额数字进入视线。
			children.push(react.createElement(ModelLimitBadge, { key: 'limit-badge' }))
			// 最近输出速度：空闲（无增量）时不渲染，不占位。
			children.push(react.createElement(SpeedMeter, { key: 'speed', chatSource: props.chatSource }))

			if (state.status === 'loading') {
				children.push(react.createElement('span', { key: 'loading', style: S.muted }, 'WorkBuddy 积分读取中…'))
			} else if (state.data) {
				const d = state.data
				children.push(react.createElement('span', { key: 'label', style: S.label }, 'WorkBuddy 剩余积分'))
				children.push(react.createElement('span', { key: 'remain', style: S.value }, fmt(d.remain)))
				// 账号数 + 异常数。新网关的 /status 不再给出「总额/已用」，只给每账号
				// 剩余积分，所以这里不做除法也不显示已用，改为说明汇总是几个号。
				const t = d.total ?? {}
				if (typeof t.accounts === 'number' && t.accounts > 0) {
					const bad = (t.cooling ?? 0) + (t.disabled ?? 0)
					const text = bad > 0 ? `${t.accounts} 个账号 · ${bad} 个异常` : `${t.accounts} 个账号`
					children.push(react.createElement('span', { key: 'sep1', style: S.sep }, '·'))
					children.push(react.createElement('span', { key: 'accounts', style: S.muted }, text))
				}
				// 上一次刷新失败但手里还有旧值时，标注一下，避免把陈旧数字当实时值。
				if (state.error !== '') {
					children.push(react.createElement('span', { key: 'stale', style: S.muted }, '（刷新失败，显示上次结果）'))
				}
			} else {
				children.push(react.createElement('span', { key: 'err', style: S.err }, `积分不可用：${state.error}`))
			}

			// 悬停展示各账号池余额明细（需求②）：无数据时不显示 title。
			const title = state.data ? accountsTitle(state.data) : state.error || undefined

			return react.createElement('div', { style: S.wrap, title }, children)
		}

		/**
		 * 浏览器插件依赖：slots（挂载插槽）+ uiConversation（订阅会话快照测速）。
		 * uiConversation 缺失时 apply 里按可选处理，插件仍可挂载（只少速度显示）。
		 */
		const inject = ['slots', 'uiConversation']

		/**
		 * 把积分行挂到输入卡片下方的 dock 插槽。
		 * @param ctx - 浏览器上下文，携带 slots / uiConversation 服务。
		 */
		function apply(ctx) {
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'wb-credits',
						// inject 工厂收 sessionId（会话作用域插槽的注入面）：用它解析当前会话
						// 的 chat 视图快照源，SpeedMeter 才能订阅到流式中的 partial blocks。
						inject: (sessionId) => {
							let chatSource
							try {
								chatSource = sessionId === undefined ? undefined : ctx.uiConversation?.binding(sessionId)?.target?.('chat')
							} catch {
								// 会话尚未绑定（如启动瞬间的空状态）：速度计降级为不显示，积分行不受影响。
								chatSource = undefined
							}
							return { chatSource }
						},
					},
					CreditsDock,
				),
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
