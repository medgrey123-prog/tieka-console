// Agent 观察台 — 飞书异常提醒 + 周期汇报
//
// 链路：watchTick() 采一次 summary → 判定异常（读不到/恢复）/是否该汇报 → POST agent-autoloop 中台 /v1/tell
//      → 中台给本人发一张通知卡（飞书 + 桌面通知，不需要模型调用）。
// 每条推送（即时提醒与周期汇报）都包含 3 个 Agent 的一行现状 + 「遇到问题」小节。
//
// 只用 node: 内置模块；中台地址与来源密钥只在本机读取，不出 Host。
// 所有失败（没装中台、网络断、config 坏）都只降级为返回值里的 error，绝不抛到
// summary / steps 的路由或工具上。

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { AGENT_IDS, collectSummary } from './agents/index.js'
import { CACHE_DIR, ObserverError, nowIso, truncate } from './util.js'

/** 中台配置（地址 + 来源密钥）。 */
export const HUB_CONFIG_FILE = path.join(homedir(), '.agent-autoloop', 'config.json')
/** 提醒配置：可选覆盖默认阈值；不存在时全用默认值。 */
export const NOTIFY_CONFIG_FILE = path.join(CACHE_DIR, 'notify.json')
/** 提醒状态：每个 agent 上次 status 与每类推送时间，重启不重复轰炸。 */
export const NOTIFY_STATE_FILE = path.join(CACHE_DIR, 'notify-state.json')

/** 默认阈值（`~/.cache/dsh-agent-observer/notify.json` 可覆盖）。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  intervalSec: 120, // 后台采集间隔（秒）
  cooldownSec: 3600, // 同一 agent 同一类提醒的最小间隔（秒）
  recovery: true, // 是否推「恢复」通知
  tellSource: '', // 可选：覆盖 config.json 的 source.key（换一个来源密钥/卡片来源名）
  reportEnabled: true, // 周期汇报开关
  reportIntervalSec: 1800, // 周期汇报间隔（默认 30 分钟）
  quietHours: Object.freeze({ start: 23, end: 8 }), // 免打扰时段（本地时间，[start,end)），start===end 表示不启用
})

// 配置钳制范围：间隔别小于 15s（summary 要读文件），冷却别小于 1 分钟。
const INTERVAL_MIN_SEC = 15
const INTERVAL_MAX_SEC = 86400
const COOLDOWN_MIN_SEC = 60
const COOLDOWN_MAX_SEC = 7 * 86400
const REPORT_INTERVAL_MIN_SEC = 60
const REPORT_INTERVAL_MAX_SEC = 7 * 86400
const TELL_TIMEOUT_MS = 10_000
const TELL_MAX_TEXT = 20_000
/** 周期汇报 / 即时提醒的正文上限（飞书可读性，任务约定 ≤2000 字）。 */
const REPORT_MAX_TEXT = 2000
const MAX_PUSHES = 30
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
const KINDS = ['error', 'recovery']
/** 「最近步骤」里出现这些词 → 标「疑似报错」（只用于概览/问题小节，不单独触发即时提醒）。 */
const SUSPECT_PATTERN = /报错|失败|异常|错误|error|failed|exception|超时|timeout/i

/** 自测/联调可用环境变量把配置/状态文件指到 /tmp，避免碰真实路径（selftest 就这样做）。 */
function envPath(name, fallback) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim() ? value.trim() : fallback
}

export function defaultNotifyConfigFile() {
  return envPath('AGENT_OBSERVER_NOTIFY_CONFIG', NOTIFY_CONFIG_FILE)
}

export function defaultNotifyStateFile() {
  return envPath('AGENT_OBSERVER_NOTIFY_STATE', NOTIFY_STATE_FILE)
}

function numberIn(value, min, max, fallback) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.round(parsed)))
}

/** DRY_RUN=1（也认 true/yes/on）：只判定不打网络；测试/联调专用。 */
export function isDryRun(options = {}) {
  if (options && typeof options.dryRun === 'boolean') return options.dryRun
  const value = String(process.env.DRY_RUN ?? '').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
}

function localTimeString(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`
}

// ---------------------------------------------------------------------------
// 中台配置
// ---------------------------------------------------------------------------

/** 读 `~/.agent-autoloop/config.json` 的 url + source.key；缺失抛带 code 的 ObserverError。 */
export function readHubConfig() {
  let raw
  try {
    raw = readFileSync(HUB_CONFIG_FILE, 'utf8')
  } catch {
    throw new ObserverError('NOT_INSTALLED', `没找到 ${HUB_CONFIG_FILE}：这台机器还没装 agent-autoloop`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ObserverError('BAD_CONFIG', `${HUB_CONFIG_FILE} 不是合法 JSON`)
  }
  if (!parsed || typeof parsed !== 'object') throw new ObserverError('BAD_CONFIG', `${HUB_CONFIG_FILE} 不是对象`)
  const url = typeof parsed.url === 'string' ? parsed.url.trim().replace(/\/+$/, '') : ''
  if (!/^https?:\/\//.test(url)) throw new ObserverError('BAD_CONFIG', `${HUB_CONFIG_FILE} 里没有有效的中台地址 url`)
  const sourceKey = parsed.source && typeof parsed.source.key === 'string' ? parsed.source.key.trim() : ''
  if (!sourceKey) throw new ObserverError('NO_SOURCE', `${HUB_CONFIG_FILE} 的 source.key 为空（这台机器没有来源密钥）`)
  return {
    url,
    sourceKey,
    sourceName: parsed.source && typeof parsed.source.name === 'string' ? parsed.source.name.trim() : '',
    configFile: HUB_CONFIG_FILE,
  }
}

/** 归一化免打扰时段：支持 {start,end} 或 "23:00-08:00"；非法给默认 23–8；start===end 表示不启用。 */
function parseQuietHours(value) {
  const fallback = { start: DEFAULT_CONFIG.quietHours.start, end: DEFAULT_CONFIG.quietHours.end }
  if (value === false || value === null) return { start: 0, end: 0 }
  if (typeof value === 'string') {
    const match = /^(\d{1,2})(?::\d{2})?\s*[-–~～]\s*(\d{1,2})(?::\d{2})?$/.exec(value.trim())
    if (!match) return fallback
    const start = Number(match[1])
    const end = Number(match[2])
    return Number.isInteger(start) && start >= 0 && start <= 23 && Number.isInteger(end) && end >= 0 && end <= 23
      ? { start, end }
      : fallback
  }
  if (value && typeof value === 'object') {
    const start = Number(value.start)
    const end = Number(value.end)
    if (Number.isInteger(start) && start >= 0 && start <= 23 && Number.isInteger(end) && end >= 0 && end <= 23) {
      return { start, end }
    }
  }
  return fallback
}

/** 读提醒配置；文件不存在/坏掉都给默认值（不抛）。 */
export function readNotifyConfig(file = defaultNotifyConfigFile()) {
  const config = { ...DEFAULT_CONFIG, quietHours: { ...DEFAULT_CONFIG.quietHours }, configFile: file, configError: null }
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return config
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    config.configError = `${file} 不是合法 JSON，已用默认值`
    return config
  }
  if (!parsed || typeof parsed !== 'object') {
    config.configError = `${file} 不是对象，已用默认值`
    return config
  }
  if (typeof parsed.enabled === 'boolean') config.enabled = parsed.enabled
  if (parsed.intervalSec !== undefined) {
    config.intervalSec = numberIn(parsed.intervalSec, INTERVAL_MIN_SEC, INTERVAL_MAX_SEC, DEFAULT_CONFIG.intervalSec)
  }
  if (parsed.cooldownSec !== undefined) {
    config.cooldownSec = numberIn(parsed.cooldownSec, COOLDOWN_MIN_SEC, COOLDOWN_MAX_SEC, DEFAULT_CONFIG.cooldownSec)
  }
  if (typeof parsed.recovery === 'boolean') config.recovery = parsed.recovery
  if (typeof parsed.tellSource === 'string') config.tellSource = parsed.tellSource.trim().slice(0, 200)
  if (typeof parsed.reportEnabled === 'boolean') config.reportEnabled = parsed.reportEnabled
  if (parsed.reportIntervalSec !== undefined) {
    config.reportIntervalSec = numberIn(
      parsed.reportIntervalSec,
      REPORT_INTERVAL_MIN_SEC,
      REPORT_INTERVAL_MAX_SEC,
      DEFAULT_CONFIG.reportIntervalSec,
    )
  }
  if (parsed.quietHours !== undefined) config.quietHours = parseQuietHours(parsed.quietHours)
  return config
}

/** 生效中的中台配置：`notify.json` 的 tellSource 可覆盖来源密钥（不是合法 key 时忽略）。 */
export function readActiveHub(config = readNotifyConfig()) {
  const hub = readHubConfig()
  const override = config && typeof config.tellSource === 'string' ? config.tellSource.trim() : ''
  if (override && KEY_PATTERN.test(override)) return { ...hub, sourceKey: override, overridden: true }
  return { ...hub, overridden: false }
}

// ---------------------------------------------------------------------------
// /v1/tell
// ---------------------------------------------------------------------------

/**
 * POST 中台 `/v1/tell`（source 形态：body 只能是 `{key,text}`）。
 * 返回 {sent, duplicate, card?, key}；DRY_RUN 时 {sent:false, dryRun:true} 不打网络。
 * 失败抛带 code 的 ObserverError（TIMEOUT / UNREACHABLE / HUB_HTTP / BAD_KEY / BAD_TEXT）。
 */
export async function sendTell(input, options = {}) {
  const key = String((input && input.key) || '').trim()
  const text = String((input && input.text) || '').trim()
  if (!KEY_PATTERN.test(key)) {
    throw new ObserverError(
      'BAD_KEY',
      `tell 的 key 不合法：${truncate(key, 60) || '(空)'}（要小写字母/数字开头，只含 a-z0-9._-，最多 64 字）`,
    )
  }
  if (!text) throw new ObserverError('BAD_TEXT', 'tell 的 text 不能为空')
  if (text.length > TELL_MAX_TEXT) throw new ObserverError('BAD_TEXT', `tell 的 text 最多 ${TELL_MAX_TEXT} 字`)

  if (isDryRun(options)) return { sent: false, duplicate: false, dryRun: true, key }

  const hub = options.hub || readHubConfig()
  const url = `${hub.url}/v1/tell`
  const timeout = Number.isFinite(options.timeout) ? options.timeout : TELL_TIMEOUT_MS
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${hub.sourceKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ key, text }),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ObserverError('TIMEOUT', `中台 ${hub.url} 超过 ${Math.round(timeout / 1000)} 秒没响应`)
    }
    throw new ObserverError('UNREACHABLE', `连不上中台 ${hub.url}（agent-autoloop up 起了吗？）`)
  }
  const raw = await response.text().catch(() => '')
  let data = null
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    data = null
  }
  if (!response.ok) {
    const reason = data && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`
    throw new ObserverError('HUB_HTTP', `中台拒绝 tell：${truncate(reason, 160)}`)
  }
  const duplicate = Boolean(data && data.duplicate)
  return {
    sent: !duplicate,
    duplicate,
    card: data && Number.isFinite(data.card) ? data.card : null,
    key,
  }
}

/** 发一条测试提醒（key `obs-test-<毫秒>`）；DRY_RUN=1 时不真发。 */
export async function sendTestTell(options = {}) {
  const config = options.config || readNotifyConfig(options.configFile)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const dryRun = isDryRun(options)
  const hub = options.hub || (dryRun ? undefined : readActiveHub(config))
  const key = `obs-test-${now}`
  const text = `Agent 观察台测试：飞书通道已接通（${localTimeString(now)}）`
  const sent = await sendTell({ key, text }, { hub, dryRun, timeout: options.timeout })
  return { ...sent, key, text }
}

/**
 * POST /agents/notify/report：立即发一次周期汇报（用于验证/手动触发）。
 * 手动触发忽略免打扰时段；发送成功（含 DRY_RUN 的「已处理」）才更新 lastReportAt。
 */
export async function sendManualReport(options = {}) {
  const config = options.config || readNotifyConfig(options.configFile)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const at = new Date(now).toISOString()
  const dryRun = isDryRun(options)
  const hub = options.hub || (dryRun ? { url: '', dryRun: true } : readActiveHub(config))
  let summary
  try {
    summary = options.summary || (typeof options.collect === 'function' ? await options.collect() : await collectSummary())
  } catch (error) {
    throw new ObserverError('SUMMARY_FAILED', `采集 summary 失败：${truncate((error && error.message) || String(error), 160)}`)
  }
  const agents = Array.isArray(summary && summary.agents) ? summary.agents : []
  const problems = collectProblems(agents)
  const text = buildReportText({ agents, problems, now, config })
  const key = reportKey(now)
  const sent = await sendTell({ key, text }, { hub, dryRun, timeout: TELL_TIMEOUT_MS })
  const delivered = Boolean(sent.sent || sent.duplicate || sent.dryRun)
  const stateFile = options.stateFile
  const state = readNotifyState(stateFile)
  let stateError = null
  if (delivered) {
    state.lastReportAt = at
    state.lastReportKey = key
    state.updatedAt = at
    state.pushes.push({
      at,
      agent: 'all',
      name: '全部',
      kind: 'report',
      status: 'report',
      key,
      sent: Boolean(sent.sent),
      duplicate: Boolean(sent.duplicate),
      dryRun: Boolean(sent.dryRun),
      manual: true,
      text: truncate(text, 200),
    })
    state.pushes = state.pushes.slice(-MAX_PUSHES)
    try {
      writeNotifyState(state, stateFile)
    } catch (error) {
      stateError = truncate((error && error.message) || String(error), 160)
    }
  }
  return {
    sent: Boolean(sent.sent),
    duplicate: Boolean(sent.duplicate),
    dryRun: Boolean(sent.dryRun),
    key,
    at,
    text,
    stateError,
  }
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

function freshState() {
  return {
    version: 1,
    updatedAt: null,
    lastTickAt: null,
    summaryGeneratedAt: null,
    lastReportAt: null,
    lastReportKey: null,
    reportBaselineAt: null,
    agents: {},
    pushes: [],
  }
}

function emptyEntry() {
  return { status: null, statusAt: null, alerted: false, lastPushAt: null, lastPushKind: null, lastKinds: {} }
}

function normalizeEntry(raw) {
  const entry = emptyEntry()
  if (!raw || typeof raw !== 'object') return entry
  if (typeof raw.status === 'string') entry.status = raw.status
  if (typeof raw.statusAt === 'string') entry.statusAt = raw.statusAt
  entry.alerted = Boolean(raw.alerted)
  if (typeof raw.lastPushAt === 'string') entry.lastPushAt = raw.lastPushAt
  if (typeof raw.lastPushKind === 'string') entry.lastPushKind = raw.lastPushKind
  const kinds = raw.lastKinds && typeof raw.lastKinds === 'object' ? raw.lastKinds : {}
  for (const kind of KINDS) {
    const value = kinds[kind]
    if (value && typeof value === 'object' && typeof value.at === 'string') {
      entry.lastKinds[kind] = { at: value.at, key: typeof value.key === 'string' ? value.key : null }
    }
  }
  return entry
}

/** 读状态文件；不存在/坏掉都给空状态（坏文件下次 tick 会被覆盖重建）。 */
export function readNotifyState(file = defaultNotifyStateFile()) {
  const state = freshState()
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return state
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return state
  }
  if (!parsed || typeof parsed !== 'object') return state
  if (typeof parsed.updatedAt === 'string') state.updatedAt = parsed.updatedAt
  if (typeof parsed.lastTickAt === 'string') state.lastTickAt = parsed.lastTickAt
  if (typeof parsed.summaryGeneratedAt === 'string') state.summaryGeneratedAt = parsed.summaryGeneratedAt
  if (typeof parsed.lastReportAt === 'string') state.lastReportAt = parsed.lastReportAt
  if (typeof parsed.lastReportKey === 'string') state.lastReportKey = parsed.lastReportKey
  if (typeof parsed.reportBaselineAt === 'string') state.reportBaselineAt = parsed.reportBaselineAt
  const agents = parsed.agents && typeof parsed.agents === 'object' ? parsed.agents : {}
  for (const id of Object.keys(agents)) state.agents[id] = normalizeEntry(agents[id])
  if (Array.isArray(parsed.pushes)) {
    state.pushes = parsed.pushes.filter((push) => push && typeof push === 'object').slice(-MAX_PUSHES)
  }
  return state
}

function writeNotifyState(state, file = defaultNotifyStateFile()) {
  const target = file || defaultNotifyStateFile()
  mkdirSync(path.dirname(target), { recursive: true })
  const temp = `${target}.tmp-${process.pid}`
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temp, target)
}

// ---------------------------------------------------------------------------
// 异常判定
// ---------------------------------------------------------------------------

/** 去重 key：`obs-<agent>-<kind>-<hourBucket>`，同 key 中台只发一次（幂等）。 */
export function notifyKey(agentId, kind, hourBucket) {
  const agent = String(agentId || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
  const safeKind = String(kind || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '')
  const bucket = Number.isFinite(hourBucket) ? Math.trunc(hourBucket) : Math.floor(Date.now() / 3600000)
  const key = `obs-${agent}-${safeKind}-${bucket}`
  return key.length <= 64 ? key : key.slice(0, 64)
}

/**
 * 纯判定函数：给定 agent 当前状态与上次状态，返回 `{kind, reason}` 或 null。
 *  1) status === 'error' → 读不到（每 tick 都可能命中，靠冷却限流）
 *  2) 之前报过异常（alerted）的 agent 恢复 working/idle → 恢复通知（可关）
 *
 * lite 只监控读会话文件的 Claude / Codex / DSH，没有「窗口消失」这一类信号，
 * 所以不再有 GUI 掉线判定；offline 只是「很久没活动」，不是异常，不推即时提醒。
 */
export function judgeAgent(agent, prevStatus, options = {}) {
  if (!agent || typeof agent !== 'object') return null
  const status = typeof agent.status === 'string' ? agent.status : ''
  const recoveryEnabled = options.recovery !== false
  const alerted = Boolean(options.alerted)
  if (status === 'error') {
    const detail = truncate(agent.detail || agent.step || '采集失败', 120) || '采集失败'
    return { kind: 'error', reason: `读不到（${detail}）` }
  }
  if (recoveryEnabled && alerted && (prevStatus === 'error' || prevStatus === 'offline') && (status === 'working' || status === 'idle')) {
    return { kind: 'recovery', reason: status === 'working' ? '正在干活' : '空闲' }
  }
  return null
}

// ---------------------------------------------------------------------------
// 文本格式：每条推送都带 3 个 Agent 的现状 + 问题小节
// ---------------------------------------------------------------------------

function shortStamp(ms) {
  const date = new Date(ms)
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 周期汇报 tell key：`obs-report-<YYYYMMDD-HH>`（本地时间小时桶，中台幂等）。 */
export function reportKey(now) {
  const date = new Date(now)
  const pad = (value) => String(value).padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}`
  return `obs-report-${stamp}`
}

function shortAgo(ageSec) {
  if (!Number.isFinite(ageSec)) return ''
  if (ageSec < 60) return '不到 1 分钟'
  if (ageSec < 3600) return `${Math.round(ageSec / 60)} 分钟`
  if (ageSec < 86400) {
    const hours = (ageSec / 3600).toFixed(1).replace(/\.0$/, '')
    return `${hours} 小时`
  }
  return `${Math.round(ageSec / 86400)} 天`
}

function humanInterval(seconds) {
  const value = Number(seconds)
  if (!Number.isFinite(value) || value <= 0) return '定期'
  if (value % 3600 === 0) return `每 ${value / 3600} 小时`
  if (value % 60 === 0) return `每 ${value / 60} 分钟`
  return `每 ${Math.round(value)} 秒`
}

function statusText(agent) {
  if (agent.status === 'working') return '在干活'
  if (agent.status === 'idle') {
    const ago = shortAgo(agent.ageSec)
    return ago ? `空闲 ${ago}` : '空闲'
  }
  if (agent.status === 'offline') return '离线（很久没活动）'
  if (agent.status === 'error') return '异常（读不到）'
  return agent.status ? String(agent.status) : '未知'
}

function agentContext(agent) {
  if (agent.session && agent.session.title) return `会话「${truncate(agent.session.title, 30)}」`
  return ''
}

function agentActivity(agent) {
  if (agent.status === 'error') {
    return `最近：${truncate(agent.detail || agent.step || '采集失败', 80)}`
  }
  const text = truncate(agent.step || agent.detail || '', 70)
  return `最近：${text || '—'}`
}

/** 一个 agent 一行：状态 · 上下文 · 最近步骤。 */
export function formatAgentLine(agent) {
  const name = (agent && (agent.name || agent.id)) || 'Agent'
  const parts = [`${name}：${statusText(agent)}`]
  const context = agentContext(agent)
  if (context) parts.push(context)
  parts.push(agentActivity(agent))
  return parts.join(' · ')
}

/** 从最近步骤里抽「命中的一句」（截断）；没有命中返回 null。 */
function matchSentence(text, max = 60) {
  const source = truncate(text, 600)
  const match = SUSPECT_PATTERN.exec(source)
  if (!match) return null
  const parts = source.split(/[。！？!?；;\n]/)
  let offset = 0
  for (const part of parts) {
    const end = offset + part.length
    if (match.index >= offset && match.index <= end) {
      const sentence = part.trim()
      if (sentence) return truncate(sentence, max)
    }
    offset = end + 1
  }
  return truncate(source, max)
}

/**
 * 判定「遇到问题」：status==='error'；最近步骤命中疑似报错词。
 * 其余算正常。返回 [{id,name,kind:'error'|'suspected',label}]。
 */
export function collectProblems(agents) {
  const problems = []
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || typeof agent.id !== 'string' || !agent.id) continue
    const name = agent.name || agent.id
    if (agent.status === 'error') {
      problems.push({
        id: agent.id,
        name,
        kind: 'error',
        label: `${name} 读不到（${truncate(agent.detail || '采集失败', 80)}）`,
      })
      continue
    }
    const sentence = matchSentence(agent.step || '')
    if (sentence) {
      problems.push({ id: agent.id, name, kind: 'suspected', label: `${name} 疑似报错（${sentence}）` })
    }
  }
  return problems
}

/** 「问题」小节：命中的问题 + 其余正常数量。 */
function formatProblems(agents, problems) {
  const total = Array.isArray(agents) ? agents.length : 0
  if (!Array.isArray(problems) || problems.length === 0) return [`✅ 全部 ${total} 个正常。`]
  const lines = [`⚠️ 问题：${problems.map((problem) => problem.label).join('；')}`]
  const normal = total - problems.length
  if (normal > 0) lines.push(`其余 ${normal} 个正常。`)
  return lines
}

function fitText(text, max = REPORT_MAX_TEXT) {
  const value = String(text || '')
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

/** 周期汇报正文（≤2000 字）：表头 + 3 行现状 + 问题小节 + 说明。 */
export function buildReportText({ agents, problems, now, config }) {
  const list = Array.isArray(agents) ? agents : []
  const found = Array.isArray(problems) ? problems : collectProblems(list)
  const lines = [`【Agent 运行汇报】${shortStamp(now)}`]
  for (const agent of list) lines.push(formatAgentLine(agent))
  lines.push(...formatProblems(list, found))
  lines.push(`（${humanInterval(config && config.reportIntervalSec)}自动汇报；异常变化即时提醒）`)
  return fitText(lines.join('\n'))
}

/** 异常/恢复即时提醒正文：开头点明哪个 agent 出了什么问题 + 同样的全量现状与问题小节。 */
export function buildAlertText({ kind, reason, agent, agents, problems, now, config }) {
  const list = Array.isArray(agents) ? agents : []
  const found = Array.isArray(problems) ? problems : collectProblems(list)
  const name = (agent && (agent.name || agent.id)) || 'Agent'
  const lines = []
  if (kind === 'recovery') lines.push(`✅ Agent 恢复：${name} 已恢复（${reason || '正常'}）`)
  else lines.push(`⚠️ Agent 异常：${name} ${reason || '状态异常'}`)
  lines.push(`【Agent 现状】${shortStamp(now)}`)
  for (const item of list) lines.push(formatAgentLine(item))
  lines.push(...formatProblems(list, found))
  lines.push(`（异常变化即时提醒；${humanInterval(config && config.reportIntervalSec)}自动汇报）`)
  return fitText(lines.join('\n'))
}

// ---------------------------------------------------------------------------
// 周期汇报：到期判断 / 免打扰
// ---------------------------------------------------------------------------

/** 本地时间是否在免打扰时段（[start,end)，跨午夜用 start>end 表达；start===end 表示不启用）。 */
export function isQuietHour(now, quietHours) {
  const quiet = quietHours || DEFAULT_CONFIG.quietHours
  const start = Number(quiet.start)
  const end = Number(quiet.end)
  if (!Number.isInteger(start) || !Number.isInteger(end) || start === end) return false
  const hour = new Date(now).getHours()
  return start < end ? hour >= start && hour < end : hour >= start || hour < end
}

/** 免打扰时段内，把时间推到下一个允许的时刻；不在时段内原样返回。 */
export function nextAllowedAt(ms, quietHours) {
  if (!isQuietHour(ms, quietHours)) return ms
  const date = new Date(ms)
  date.setMinutes(0, 0, 0)
  for (let i = 0; i < 32; i += 1) {
    date.setHours(date.getHours() + 1)
    if (!isQuietHour(date.getTime(), quietHours)) return date.getTime()
  }
  return ms
}

/**
 * 下一次周期汇报的原始到期时刻：上次成功汇报/基线 + interval。
 * 还没写过基线（从未 tick 过）返回 null（首次 tick 只写基线，不发送）。
 * reportEnabled=false 返回 null。
 */
export function reportDueAt(config, state, now = Date.now()) {
  if (!config || config.reportEnabled === false) return null
  const intervalMs = Math.max(60, Number(config.reportIntervalSec) || DEFAULT_CONFIG.reportIntervalSec) * 1000
  const base = state && (state.lastReportAt || state.reportBaselineAt)
  if (!base) return null
  const parsed = Date.parse(base)
  return Number.isFinite(parsed) ? parsed + intervalMs : now
}

/** 供 GET /agents/notify/state：下一次真正会被允许的汇报时刻（考虑免打扰；到期未发显示 now）。 */
export function nextReportAllowedAt(config, state, now = Date.now()) {
  const due = reportDueAt(config, state, now)
  const intervalMs = Math.max(60, Number(config && config.reportIntervalSec) || DEFAULT_CONFIG.reportIntervalSec) * 1000
  const target = due === null ? now + intervalMs : Math.max(due, now)
  return new Date(nextAllowedAt(target, config && config.quietHours)).toISOString()
}

// ---------------------------------------------------------------------------
// 每个 tick：采集 → 判定 → 冷却 → 推送 → 落状态
// ---------------------------------------------------------------------------

let ticking = false

/**
 * 跑一个提醒 tick。默认采集真实 summary、写真实状态文件；
 * options 里可注入 {summary, collect, config, configFile, stateFile, hub, now, dryRun} 供自测。
 */
export async function watchTick(options = {}) {
  if (ticking) return { ok: true, at: nowIso(), skipped: 'busy', pushed: [], suppressed: [] }
  ticking = true
  try {
    return await runTick(options && typeof options === 'object' ? options : {})
  } finally {
    ticking = false
  }
}

async function runTick(options) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  // at 用 now 推导（而不是直接 nowIso），自测注入 now 时冷却/状态时间才是同一套时钟。
  const at = new Date(now).toISOString()
  const config = options.config || readNotifyConfig(options.configFile)
  const dryRun = isDryRun(options)
  const result = {
    ok: true,
    at,
    enabled: config.enabled,
    dryRun,
    checked: 0,
    baseline: [],
    pushed: [],
    suppressed: [],
    failures: [],
    report: null,
    hubError: null,
    stateError: null,
    skipped: null,
  }
  if (!config.enabled) {
    result.skipped = 'disabled'
    return result
  }

  let hub = options.hub || null
  if (!dryRun) {
    try {
      hub = hub || readActiveHub(config)
    } catch (error) {
      result.ok = false
      result.skipped = 'no-hub-config'
      result.hubError = {
        code: (error && error.code) || 'HUB_CONFIG',
        message: truncate((error && error.message) || String(error), 160),
      }
      return result
    }
  } else if (!hub) {
    hub = { url: '', dryRun: true }
  }

  let summary
  try {
    summary = options.summary || (typeof options.collect === 'function' ? await options.collect() : await collectSummary())
  } catch (error) {
    result.ok = false
    result.skipped = 'summary-failed'
    result.error = {
      code: (error && error.code) || 'SUMMARY_FAILED',
      message: truncate((error && error.message) || String(error), 160),
    }
    return result
  }

  const state = readNotifyState(options.stateFile)
  const agents = Array.isArray(summary && summary.agents) ? summary.agents : []
  const problems = collectProblems(agents)
  const cooldownMs = config.cooldownSec * 1000
  const hourBucket = Math.floor(now / 3600000)
  result.checked = agents.length

  for (const agent of agents) {
    if (!agent || typeof agent.id !== 'string' || !agent.id) continue
    const id = agent.id
    const entry = state.agents[id] || normalizeEntry(null)
    const prevStatus = entry.status
    if (prevStatus === null) result.baseline.push(id)
    const action = judgeAgent(agent, prevStatus, { recovery: config.recovery, alerted: entry.alerted })
    // 推送失败时不推进状态：下一 tick 仍能判定出同一个「error→恢复」再试一次。
    let advanceStatus = true

    if (action) {
      const last = entry.lastKinds[action.kind]
      const lastAt = last ? Date.parse(last.at) : NaN
      if (Number.isFinite(lastAt) && now - lastAt < cooldownMs) {
        result.suppressed.push({ agent: id, kind: action.kind, reason: 'cooldown' })
      } else {
        const key = notifyKey(id, action.kind, hourBucket)
        // 每条即时提醒都带全量 3 行现状 + 问题小节（开头点名是哪个 agent 出了什么问题）。
        const text = buildAlertText({ kind: action.kind, reason: action.reason, agent, agents, problems, now, config })
        try {
          const sent = await sendTell({ key, text }, { hub, dryRun, timeout: TELL_TIMEOUT_MS })
          // dry-run 也算「这次判定已处理」，否则每次自测都会重复判定同一异常。
          const delivered = Boolean(sent.sent || sent.duplicate || sent.dryRun)
          if (delivered) {
            entry.lastKinds[action.kind] = { at, key }
            entry.lastPushAt = at
            entry.lastPushKind = action.kind
            entry.alerted = action.kind !== 'recovery'
          }
          state.pushes.push({
            at,
            agent: id,
            name: agent.name || id,
            kind: action.kind,
            status: agent.status,
            key,
            sent: Boolean(sent.sent),
            duplicate: Boolean(sent.duplicate),
            dryRun: Boolean(sent.dryRun),
            text: truncate(text, 200),
          })
          result.pushed.push({
            agent: id,
            kind: action.kind,
            key,
            sent: Boolean(sent.sent),
            duplicate: Boolean(sent.duplicate),
            dryRun: Boolean(sent.dryRun),
          })
        } catch (error) {
          advanceStatus = false
          const message = truncate((error && error.message) || String(error), 160)
          state.pushes.push({
            at,
            agent: id,
            name: agent.name || id,
            kind: action.kind,
            status: agent.status,
            key,
            sent: false,
            duplicate: false,
            dryRun,
            error: message,
          })
          result.failures.push({ agent: id, kind: action.kind, key, code: (error && error.code) || 'TELL_FAILED', message })
        }
      }
    }

    // 状态推进：推送失败的那一类保持旧状态等下一 tick 重试；成功/冷却中的正常推进。
    if (advanceStatus && (entry.status !== agent.status || !entry.statusAt)) {
      entry.status = agent.status
      entry.statusAt = at
    }
    state.agents[id] = entry
  }

  // 周期汇报：首次 tick 只记基线（避免 reload 后立刻真发飞书，真实验证走 POST /agents/notify/report）；
  // 之后到期且不在免打扰时段才发；发送成功才更新 lastReportAt，失败下个 tick 重试（不会重复刷屏）。
  if (config.reportEnabled) {
    if (!state.lastReportAt && !state.reportBaselineAt) {
      state.reportBaselineAt = at
      result.report = { due: false, sent: false, duplicate: false, skipped: 'baseline' }
    } else {
      const reportDue = reportDueAt(config, state, now)
      if (reportDue !== null && now >= reportDue) {
        if (isQuietHour(now, config.quietHours)) {
          result.report = { due: true, sent: false, duplicate: false, skipped: 'quiet' }
        } else {
          const key = reportKey(now)
          const text = buildReportText({ agents, problems, now, config })
          try {
            const sent = await sendTell({ key, text }, { hub, dryRun, timeout: TELL_TIMEOUT_MS })
            const delivered = Boolean(sent.sent || sent.duplicate || sent.dryRun)
            if (delivered) {
              state.lastReportAt = at
              state.lastReportKey = key
            }
            state.pushes.push({
              at,
              agent: 'all',
              name: '全部',
              kind: 'report',
              status: 'report',
              key,
              sent: Boolean(sent.sent),
              duplicate: Boolean(sent.duplicate),
              dryRun: Boolean(sent.dryRun),
              text: truncate(text, 200),
            })
            result.report = {
              due: true,
              sent: Boolean(sent.sent),
              duplicate: Boolean(sent.duplicate),
              dryRun: Boolean(sent.dryRun),
              delivered,
              key,
            }
          } catch (error) {
            result.report = {
              due: true,
              sent: false,
              duplicate: false,
              key,
              error: {
                code: (error && error.code) || 'TELL_FAILED',
                message: truncate((error && error.message) || String(error), 160),
              },
            }
          }
        }
      }
    }
  }

  // 清掉已经不存在的 agent（历史遗留），控制文件体积。
  for (const id of Object.keys(state.agents)) {
    if (!AGENT_IDS.includes(id)) delete state.agents[id]
  }
  state.pushes = state.pushes.slice(-MAX_PUSHES)
  state.updatedAt = at
  state.lastTickAt = at
  state.summaryGeneratedAt = summary && typeof summary.generatedAt === 'string' ? summary.generatedAt : null
  try {
    writeNotifyState(state, options.stateFile)
  } catch (error) {
    result.stateError = truncate((error && error.message) || String(error), 160)
  }
  return result
}

// ---------------------------------------------------------------------------
// GET /agents/notify/state 的数据体
// ---------------------------------------------------------------------------

/** 只读视图：路由直接返回它；读配置/状态文件全部降级不抛。 */
export function notifyStateView(options = {}) {
  const config = options.config || readNotifyConfig(options.configFile)
  const state = readNotifyState(options.stateFile)
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  let hub = null
  let hubError = null
  try {
    hub = readActiveHub(config)
  } catch (error) {
    hubError = {
      code: (error && error.code) || 'HUB_CONFIG',
      message: truncate((error && error.message) || String(error), 160),
    }
  }
  return {
    enabled: config.enabled,
    intervalSec: config.intervalSec,
    cooldownSec: config.cooldownSec,
    recovery: config.recovery,
    tellSource: config.tellSource || null,
    dryRun: isDryRun(),
    configFile: config.configFile,
    configError: config.configError,
    stateFile: options.stateFile || defaultNotifyStateFile(),
    hub: hub
      ? { configured: true, url: hub.url, sourceName: hub.sourceName || null }
      : { configured: false, error: hubError },
    report: {
      enabled: config.reportEnabled,
      intervalSec: config.reportIntervalSec,
      lastReportAt: state.lastReportAt,
      lastReportKey: state.lastReportKey,
      quietHours: { start: config.quietHours.start, end: config.quietHours.end },
      quietNow: isQuietHour(now, config.quietHours),
      nextDueAt: nextReportAllowedAt(config, state, now),
    },
    lastState: {
      updatedAt: state.updatedAt,
      lastTickAt: state.lastTickAt,
      agents: state.agents,
    },
    lastPushes: state.pushes.slice(-20),
  }
}
