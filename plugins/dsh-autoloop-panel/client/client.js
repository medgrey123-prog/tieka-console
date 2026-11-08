// Autoloop 面板 — client 侧（纯 JS，无构建，React 来自浏览器模块表）
//
// 注册两处：
//  1) sidebar.panellist[id=autoloop] → 侧边栏图标（有待拍板卡片时显示角标）；
//  2) main[key=autoloop] → 全页面板：待审批卡片、在跑/排队、最近完成、成员、规则。
// 数据全部走 Host 半的同源路由 /autoloop/*（浏览器直连 127.0.0.1:3350 会被 CORS 拦）。
window.__ModuleLoader__.load({
  id: '@local/dsh-autoloop-panel',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const h = React.createElement
    const NS = 'autoloop'
    const PANEL_INTERVAL = 5000
    const ICON_INTERVAL = 15000

    const C = {
      bg: 'var(--dsw-alias-bg-base)',
      layer1: 'var(--dsw-alias-bg-layer-1)',
      layer2: 'var(--dsw-alias-bg-layer-2)',
      border: 'var(--dsw-alias-border-l1)',
      border2: 'var(--dsw-alias-border-l2)',
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      faint: 'var(--dsw-alias-label-tertiary)',
      dim: 'var(--dsw-alias-state-idle-primary)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }

    const zh = {
      nav: '铁卡老弟',
      title: '铁卡老弟',
      subtitle: '自动接活，拿不准才找你',
      connecting: '正在连接中台…',
      refresh: '刷新',
      updated: '更新于 {time}',
      online: '中台在线',
      waitingYou: '等你 {n}',
      running: '在跑 {n}',
      queued: '排队 {n}',
      todayLine: '今天 {rounds} 轮 · {tokens} tokens · {cost}',
      cardsTitle: '等你拍板',
      noCards: '没有要你拍板的事',
      ask: '提问',
      notice: '通知',
      recommended: '推荐',
      pick: '选它',
      markDone: '已处理',
      resolve: '结案',
      resolveHint: '写一句处理结果（≤1000 字）',
      confirm: '确定',
      cancel: '取消',
      answered: '已提交，等这一轮结束',
      resolvedDone: '已结案',
      acting: '处理中…',
      activeTitle: '在跑 / 排队',
      noActive: '现在没有在跑的活',
      recentTitle: '最近完成',
      noRecent: '还没有完成的轮次',
      stop: '停止',
      stoppingAction: '正在停…',
      stopHint: '停止这一轮（进程组退出后才算停）',
      membersTitle: '成员',
      noMembers: '还没有配置 Agent 或通道',
      rulesTitle: '规则',
      noRules: '还没有规则',
      ruleEvent: '按事件：{types}',
      ruleCron: '每 {every}',
      ruleNext: '下次 {time}',
      elsewhereTitle: '在别处定时跑的任务',
      unroutedTitle: '没有规则接的事件',
      notInstalledTitle: '没找到 autoloop 中台',
      notInstalledBody: '这台机器还没装 agent-autoloop，或者 config.json 里没有本人密钥。装好并启动后，面板会自动连上。',
      install1: '① 在终端安装',
      install2: '② 启动中台',
      install3: '③ 点右上角「刷新」，或等 5 秒自动重连',
      noOwnerHint: 'config.json 里有安装记录，但没有 owner 密钥：这台机器可能只是接单端（用 agent-autoloop join 接入），看不了全局。',
      errorTitle: '连不上中台',
      retry: '重试',
      unknownError: '未知错误',
      rulesFileHint: '规则：~/.agent-autoloop/rules.json · 面板每 5 秒自动刷新',
      openPanel: '打开 Autoloop 面板',
      stateQueued: '排队',
      stateClaimed: '在跑',
      stateUnknown: '不确定',
      stateDone: '完成',
      stateNothing: '没事可做',
      stateFailed: '没跑成',
      stateCancelled: '已取消',
      attempt: '第 {n} 次',
      duration: '用时 {s}',
      usage: '用量 {tokens} tokens · {cost}',
      events: '{n} 个事件',
      attention: '{n} 张卡片',
      viewAll: '查看全部 {n} 条',
      detail: '明细',
      hide: '收起',
      cardMeta: '#{id} · {rule} · {time}',
      runMeta: '第 {id} 轮 · {rule}',
      stopBusy: '正在停…',
      tabsOverview: '总览',
      tabsAgents: 'Agents',
      agentSub: 'Claude · Codex · DSH 的当前进度',
      agentLoading: '正在读取各 Agent 的进度…',
      agentNoData: '没装 / 没启用 dsh-agent-observer',
      agentNoDataHint: 'Agents 数据由独立插件 dsh-agent-observer 提供；装好并刷新页面后这里会自动出现。',
      agentUpdated: '更新于 {time}',
      agentSteps: '最近步骤',
      agentHide: '收起',
      agentGrab: '抓当前画面',
      agentGrabbing: '正在抓取…',
      agentSnapshotEmpty: '还没有抓过画面；点「抓当前画面」读一次当前界面。',
      agentOcr: '识别到的文字',
      agentSnapshotAt: '抓于 {time}',
      agentKindCode: 'CLI',
      agentKindGui: 'GUI',
      agentStatusWorking: '在干活',
      agentStatusIdle: '空闲',
      agentStatusOffline: '离线',
      agentStatusError: '读不到',
      agentSession: '会话',
      agentWindow: '窗口',
      agentOutputs: '最近产出',
      agentLastActive: '{ago}前',
      agentJustNow: '刚刚',
      agentNoSteps: '没读到步骤',
      agentLoadSteps: '读取中…',
    }

    const en = {
      nav: 'Tieka Bro',
      title: 'Tieka Bro',
      subtitle: 'Takes work on its own; pings you only when unsure',
      connecting: 'Connecting to the hub…',
      refresh: 'Refresh',
      updated: 'Updated {time}',
      online: 'Hub online',
      waitingYou: 'Waiting on you: {n}',
      running: 'Running {n}',
      queued: 'Queued {n}',
      todayLine: 'Today {rounds} rounds · {tokens} tokens · {cost}',
      cardsTitle: 'Waiting on you',
      noCards: 'Nothing needs your decision',
      ask: 'Question',
      notice: 'Notice',
      recommended: 'Recommended',
      pick: 'Pick',
      markDone: 'Mark done',
      resolve: 'Resolve',
      resolveHint: 'One line on what was decided (≤1000 chars)',
      confirm: 'Confirm',
      cancel: 'Cancel',
      answered: 'Submitted; this round will continue',
      resolvedDone: 'Resolved',
      acting: 'Working…',
      activeTitle: 'Running / queued',
      noActive: 'No rounds running right now',
      recentTitle: 'Recently finished',
      noRecent: 'No finished rounds yet',
      stop: 'Stop',
      stoppingAction: 'Stopping…',
      stopHint: 'Ask the worker to stop this round (confirmed after its process group exits)',
      membersTitle: 'Members',
      noMembers: 'No agents or channels configured yet',
      rulesTitle: 'Rules',
      noRules: 'No rules yet',
      ruleEvent: 'On event: {types}',
      ruleCron: 'Every {every}',
      ruleNext: 'Next {time}',
      elsewhereTitle: 'Scheduled elsewhere',
      unroutedTitle: 'Events no rule picked up',
      notInstalledTitle: 'Autoloop hub not found',
      notInstalledBody: 'agent-autoloop is not installed on this machine, or config.json has no owner key. The panel reconnects by itself once the hub is up.',
      install1: '① Install in a terminal',
      install2: '② Start the hub',
      install3: '③ Hit Refresh, or wait 5 seconds',
      noOwnerHint: 'config.json exists but has no owner key: this machine may only be a worker (agent-autoloop join), so it cannot see the whole board.',
      errorTitle: 'Cannot reach the hub',
      retry: 'Retry',
      unknownError: 'Unknown error',
      rulesFileHint: 'Rules: ~/.agent-autoloop/rules.json · refreshes every 5s',
      openPanel: 'Open Autoloop panel',
      stateQueued: 'Queued',
      stateClaimed: 'Running',
      stateUnknown: 'Uncertain',
      stateDone: 'Done',
      stateNothing: 'Nothing to do',
      stateFailed: 'Failed',
      stateCancelled: 'Cancelled',
      attempt: 'attempt {n}',
      duration: '{s} elapsed',
      usage: '{tokens} tokens · {cost}',
      events: '{n} events',
      attention: '{n} cards',
      viewAll: 'Show all {n}',
      detail: 'Details',
      hide: 'Hide',
      cardMeta: '#{id} · {rule} · {time}',
      runMeta: 'Run #{id} · {rule}',
      stopBusy: 'Stopping…',
      tabsOverview: 'Overview',
      tabsAgents: 'Agents',
      agentSub: 'Live progress of Claude · Codex · DSH',
      agentLoading: 'Reading agent progress…',
      agentNoData: 'dsh-agent-observer not installed / enabled',
      agentNoDataHint: 'Agent data comes from the separate dsh-agent-observer plugin; install it and refresh this page.',
      agentUpdated: 'Updated {time}',
      agentSteps: 'Recent steps',
      agentHide: 'Hide',
      agentGrab: 'Grab screen',
      agentGrabbing: 'Grabbing…',
      agentSnapshotEmpty: 'No snapshot yet; grab one to read the current screen.',
      agentOcr: 'Recognized text',
      agentSnapshotAt: 'Grabbed {time}',
      agentKindCode: 'CLI',
      agentKindGui: 'GUI',
      agentStatusWorking: 'Working',
      agentStatusIdle: 'Idle',
      agentStatusOffline: 'Offline',
      agentStatusError: 'Unreadable',
      agentSession: 'Session',
      agentWindow: 'Window',
      agentOutputs: 'Recent outputs',
      agentLastActive: '{ago} ago',
      agentJustNow: 'just now',
      agentNoSteps: 'No steps found',
      agentLoadSteps: 'Loading…',
    }

    const RULE = 'https://raw.githubusercontent.com/KKKKhazix/agent-autoloop/main/install.sh'

    const CSS = `
.alp-root { height: 100%; min-height: 0; display: flex; flex-direction: column; background: ${C.bg}; color: ${C.text}; font-size: 13px; line-height: 1.5; overflow: hidden; }
.alp-root button { font-family: inherit; }
.alp-head { display: flex; align-items: center; gap: 12px; padding: 12px clamp(14px, 2.2vw, 24px); border-bottom: 1px solid ${C.border}; flex-wrap: wrap; flex-shrink: 0; background: ${C.bg}; }
.alp-logo { width: 34px; height: 34px; border-radius: 10px; background: #0f766e; color: #f0fdfa; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; }
.alp-headtext { min-width: 0; flex: 1; }
.alp-title { font-size: 16px; font-weight: 600; letter-spacing: 0.2px; }
.alp-sub { font-size: 12px; color: ${C.sub}; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alp-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.alp-scroll { flex: 1; min-height: 0; overflow: auto; padding: 14px clamp(14px, 2.2vw, 24px) 24px; display: flex; flex-direction: column; gap: 14px; }
.alp-scroll::-webkit-scrollbar { width: 9px; height: 9px; }
.alp-scroll::-webkit-scrollbar-thumb { background: ${C.border2}; border-radius: 9px; }
.alp-section { border: 1px solid ${C.border}; border-radius: 12px; background: ${C.layer1}; overflow: hidden; flex-shrink: 0; }
.alp-section-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid ${C.border}; font-weight: 600; font-size: 13px; background: ${C.layer2}; }
.alp-count { font-size: 11px; color: ${C.sub}; font-weight: 400; }
.alp-empty { padding: 22px 14px; text-align: center; color: ${C.faint}; font-size: 12.5px; }
.alp-card { padding: 12px 14px; border-bottom: 1px solid ${C.border}; }
.alp-card:last-child { border-bottom: 0; }
.alp-card-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.alp-card-title { font-size: 14px; font-weight: 600; min-width: 0; }
.alp-meta { font-size: 11px; color: ${C.faint}; margin-left: auto; white-space: nowrap; }
.alp-text { margin-top: 6px; color: ${C.sub}; white-space: pre-wrap; word-break: break-word; font-size: 12.5px; }
.alp-badge { display: inline-flex; align-items: center; padding: 1px 8px; border-radius: 999px; font-size: 10.5px; border: 1px solid ${C.border}; color: ${C.sub}; background: ${C.bg}; white-space: nowrap; }
.alp-badge-ask { color: ${C.brand}; border-color: color-mix(in srgb, ${C.brand} 35%, transparent); background: color-mix(in srgb, ${C.brand} 10%, transparent); }
.alp-badge-run { color: ${C.warn}; border-color: color-mix(in srgb, ${C.warn} 35%, transparent); background: color-mix(in srgb, ${C.warn} 10%, transparent); }
.alp-badge-done { color: ${C.success}; border-color: color-mix(in srgb, ${C.success} 30%, transparent); background: color-mix(in srgb, ${C.success} 9%, transparent); }
.alp-badge-fail { color: ${C.error}; border-color: color-mix(in srgb, ${C.error} 35%, transparent); background: color-mix(in srgb, ${C.error} 10%, transparent); }
.alp-opts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.alp-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid ${C.border}; background: ${C.layer1}; color: ${C.text}; border-radius: 8px; padding: 5px 11px; font-size: 12px; cursor: pointer; white-space: nowrap; }
.alp-btn:hover { background: ${C.layer2}; }
.alp-btn:disabled { opacity: 0.55; cursor: default; }
.alp-btn-primary { border-color: transparent; background: ${C.brand}; color: #fff; }
.alp-btn-primary:hover { filter: brightness(1.06); background: ${C.brand}; }
.alp-opt { display: inline-flex; align-items: center; gap: 6px; border: 1px solid ${C.border2}; background: ${C.bg}; color: ${C.text}; border-radius: 999px; padding: 5px 13px; font-size: 12.5px; cursor: pointer; }
.alp-opt:hover { border-color: ${C.brand}; color: ${C.brand}; }
.alp-opt:disabled { opacity: 0.55; cursor: default; }
.alp-opt-rec { border-color: ${C.brand}; color: ${C.brand}; }
.alp-opt-rec:hover { background: color-mix(in srgb, ${C.brand} 10%, transparent); }
.alp-opt-tag { font-size: 9.5px; padding: 0 5px; border-radius: 999px; background: ${C.brand}; color: #fff; }
.alp-footrow { display: flex; align-items: center; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.alp-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.alp-input { flex: 1; min-width: 160px; border: 1px solid ${C.border2}; border-radius: 8px; background: ${C.bg}; color: ${C.text}; padding: 5px 9px; font-size: 12px; font-family: inherit; }
.alp-input:focus { outline: none; border-color: ${C.brand}; }
.alp-ok { margin-top: 8px; color: ${C.success}; font-size: 12px; }
.alp-err { margin-top: 8px; color: ${C.error}; font-size: 12px; white-space: pre-wrap; }
.alp-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 11px; border: 1px solid ${C.border}; color: ${C.sub}; white-space: nowrap; }
.alp-dot { width: 6px; height: 6px; border-radius: 999px; background: ${C.dim}; display: inline-block; }
.alp-dot-on { background: ${C.success}; }
.alp-dot-off { background: ${C.error}; }
.alp-run { padding: 10px 14px; border-bottom: 1px solid ${C.border}; }
.alp-run:last-child { border-bottom: 0; }
.alp-run-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.alp-run-name { font-weight: 500; min-width: 0; }
.alp-run-sub { color: ${C.sub}; font-size: 12px; margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
.alp-run-meta { color: ${C.faint}; font-size: 11px; margin-top: 4px; display: flex; gap: 10px; flex-wrap: wrap; }
.alp-chips { display: flex; gap: 8px; flex-wrap: wrap; padding: 12px 14px; }
.alp-chip { display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border: 1px solid ${C.border}; border-radius: 999px; font-size: 12px; background: ${C.bg}; }
.alp-rule { display: flex; align-items: center; gap: 8px; padding: 9px 14px; border-bottom: 1px solid ${C.border}; flex-wrap: wrap; }
.alp-rule:last-child { border-bottom: 0; }
.alp-rule-name { font-weight: 500; }
.alp-rule-meta { color: ${C.faint}; font-size: 11px; margin-left: auto; text-align: right; }
.alp-empty-state { max-width: 620px; margin: 6vh auto 0; padding: 0 16px; text-align: center; }
.alp-empty-icon { width: 52px; height: 52px; border-radius: 16px; margin: 0 auto 14px; background: ${C.layer1}; border: 1px solid ${C.border}; display: flex; align-items: center; justify-content: center; color: ${C.sub}; }
.alp-empty-title { font-size: 16px; font-weight: 600; margin-bottom: 6px; }
.alp-empty-body { color: ${C.sub}; font-size: 12.5px; margin-bottom: 16px; }
.alp-steps { text-align: left; display: flex; flex-direction: column; gap: 8px; }
.alp-step { display: flex; flex-direction: column; gap: 4px; padding: 9px 12px; border: 1px solid ${C.border}; border-radius: 10px; background: ${C.layer1}; font-size: 12px; }
.alp-step-label { color: ${C.faint}; font-size: 11px; }
.alp-code { font-family: ${C.mono}; font-size: 11.5px; color: ${C.text}; word-break: break-all; white-space: pre-wrap; }
.alp-foot { flex-shrink: 0; padding: 8px clamp(14px, 2.2vw, 24px); border-top: 1px solid ${C.border}; color: ${C.faint}; font-size: 11px; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.alp-tabs { display: flex; gap: 2px; padding: 0 clamp(14px, 2.2vw, 24px); border-bottom: 1px solid ${C.border}; flex-shrink: 0; background: ${C.bg}; }
.alp-tab { border: 0; background: transparent; color: ${C.sub}; font-family: inherit; font-size: 13px; padding: 8px 10px; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
.alp-tab:hover { color: ${C.text}; }
.alp-tab-on { color: var(--dsw-alias-brand-primary); border-bottom-color: var(--dsw-alias-brand-primary); font-weight: 600; }
.alp-agent-toolbar { display: flex; align-items: center; gap: 10px; color: ${C.faint}; font-size: 11px; }
.alp-agents { display: flex; flex-direction: column; gap: 12px; }
.alp-agent { border: 1px solid ${C.border}; border-radius: 12px; background: ${C.layer1}; overflow: hidden; }
.alp-agent-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; flex-wrap: wrap; }
.alp-agent-glyph { width: 26px; height: 26px; border-radius: 8px; background: ${C.layer2}; border: 1px solid ${C.border}; display: inline-flex; align-items: center; justify-content: center; font-size: 13px; color: ${C.sub}; flex-shrink: 0; }
.alp-agent-name { font-weight: 600; font-size: 14px; }
.alp-status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; white-space: nowrap; }
.alp-status-dot { width: 6px; height: 6px; border-radius: 999px; display: inline-block; }
.alp-agent-body { padding: 0 14px 12px 14px; }
.alp-agent-step { font-size: 12.5px; color: ${C.sub}; white-space: pre-wrap; word-break: break-word; margin-top: 2px; }
.alp-agent-detail { font-size: 11.5px; color: ${C.faint}; white-space: pre-wrap; word-break: break-word; margin-top: 4px; }
.alp-agent-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: ${C.faint}; margin-top: 6px; }
.alp-agent-meta b { color: ${C.sub}; font-weight: 500; }
.alp-agent-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.alp-steps { margin-top: 10px; border-top: 1px dashed ${C.border2}; padding-top: 8px; display: flex; flex-direction: column; gap: 6px; }
.alp-step-row { display: flex; gap: 8px; font-size: 12px; color: ${C.sub}; }
.alp-step-role { flex-shrink: 0; width: 56px; color: ${C.faint}; font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.03em; padding-top: 1px; }
.alp-step-text { white-space: pre-wrap; word-break: break-word; }
.alp-snapshot { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.alp-snapshot img { max-width: 100%; border-radius: 8px; border: 1px solid ${C.border}; display: block; background: ${C.layer2}; }
.alp-pre { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ${C.mono}; font-size: 11px; color: ${C.sub}; background: ${C.layer2}; border: 1px solid ${C.border}; border-radius: 8px; padding: 8px 10px; max-height: 220px; overflow: auto; }
`

    async function getJson(pathname) {
      let response
      try {
        response = await fetch(pathname, { cache: 'no-store' })
      } catch (error) {
        return { ok: false, error: { code: 'NETWORK', message: String((error && error.message) || error) } }
      }
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      if (!body || typeof body !== 'object') {
        return { ok: false, error: { code: 'BAD_RESPONSE', message: 'HTTP ' + response.status } }
      }
      if (!response.ok) {
        return { ok: false, error: body.error || { code: 'HTTP', message: 'HTTP ' + response.status } }
      }
      return body
    }

    async function postJson(pathname, payload) {
      let response
      try {
        response = await fetch(pathname, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload || {}),
        })
      } catch (error) {
        return { ok: false, error: { code: 'NETWORK', message: String((error && error.message) || error) } }
      }
      let body = null
      try {
        body = await response.json()
      } catch (error) {
        body = null
      }
      if (!body || typeof body !== 'object') {
        return { ok: false, error: { code: 'BAD_RESPONSE', message: 'HTTP ' + response.status } }
      }
      if (!response.ok) return { ok: false, error: body.error || { code: 'HTTP', message: 'HTTP ' + response.status } }
      return body
    }

    function useHub(intervalMs) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null, meta: null, updatedAt: 0 })
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const [meta, stateRes] = await Promise.all([getJson('/autoloop/meta'), getJson('/autoloop/state')])
          if (!alive) return
          const metaData = meta && meta.ok ? meta.data : null
          if (stateRes && stateRes.ok) {
            setState({ loading: false, data: stateRes.data, error: null, meta: metaData, updatedAt: Date.now() })
          } else {
            setState({
              loading: false,
              data: null,
              error: (stateRes && stateRes.error) || { code: 'UNKNOWN', message: '' },
              meta: metaData,
              updatedAt: Date.now(),
            })
          }
        }
        load()
        const timer = setInterval(load, intervalMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [intervalMs, tick])
      const refresh = React.useCallback(() => setTick((n) => n + 1), [])
      return [state, refresh]
    }

    const fmtTokens = (n) => {
      const value = Number(n) || 0
      if (value >= 1000000) return (value / 1000000).toFixed(1) + 'm'
      if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
      return String(Math.round(value))
    }
    const fmtMoney = (n) => '$' + (Number(n) || 0).toFixed(2)

    const pad = (n) => String(n).padStart(2, '0')
    const fmtTime = (iso) => {
      try {
        const date = new Date(iso)
        if (Number.isNaN(date.getTime())) return ''
        return pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
      } catch {
        return ''
      }
    }
    const fmtClock = (value) => {
      try {
        const date = new Date(value)
        if (Number.isNaN(date.getTime())) return ''
        return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
      } catch {
        return ''
      }
    }
    const elapsed = (fromIso, toMs) => {
      try {
        const start = new Date(fromIso).getTime()
        if (Number.isNaN(start)) return ''
        const seconds = Math.max(0, Math.round((toMs - start) / 1000))
        if (seconds < 60) return seconds + 's'
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's'
        return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm'
      } catch {
        return ''
      }
    }

    const STATE_KEY = {
      queued: 'stateQueued',
      claimed: 'stateClaimed',
      unknown: 'stateUnknown',
      done: 'stateDone',
      nothing: 'stateNothing',
      failed: 'stateFailed',
      cancelled: 'stateCancelled',
    }
    const STATE_TONE = {
      queued: C.sub,
      claimed: C.warn,
      unknown: C.warn,
      done: C.success,
      nothing: C.sub,
      failed: C.error,
      cancelled: C.dim,
    }

    function Dot(props) {
      const tone = props.online ? 'alp-dot alp-dot-on' : props.offline ? 'alp-dot alp-dot-off' : 'alp-dot'
      return h('span', { className: tone })
    }

    function Pill(props) {
      const tone = props.tone || C.sub
      return h(
        'span',
        {
          className: 'alp-pill',
          style: {
            color: tone,
            borderColor: 'color-mix(in srgb, ' + tone + ' 30%, transparent)',
            background: 'color-mix(in srgb, ' + tone + ' 9%, transparent)',
          },
        },
        props.children,
      )
    }

    function Icon(props) {
      const size = props.size || 14
      const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } }
      if (props.name === 'refresh') {
        return h(
          'svg',
          common,
          h('path', { d: 'M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        )
      }
      if (props.name === 'stop') {
        return h('svg', common, h('rect', { x: 6.5, y: 6.5, width: 11, height: 11, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.8 }))
      }
      if (props.name === 'loop') {
        return h(
          'svg',
          common,
          h('path', { d: 'M20 12a8 8 0 0 1-13.5 5.8M4 12a8 8 0 0 1 13.5-5.8', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' }),
          h('path', { d: 'M17.8 3.6v4.2h-4.2M6.2 20.4v-4.2h4.2', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        )
      }
      if (props.name === 'spark') {
        return h('svg', common, h('path', { d: 'M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9L12 3.5Z', stroke: 'currentColor', strokeWidth: 1.6, strokeLinejoin: 'round' }))
      }
      return h('svg', common, h('circle', { cx: 12, cy: 12, r: 8.5, stroke: 'currentColor', strokeWidth: 1.7 }))
    }

    function SectionHead(props) {
      return h(
        'div',
        { className: 'alp-section-head' },
        h(Icon, { name: props.icon, size: 14 }),
        h('span', null, props.title),
        props.count !== undefined && props.count !== null ? h('span', { className: 'alp-count' }, props.count) : null,
        props.right || null,
      )
    }

    function CardItem(props) {
      const t = props.t
      const card = props.card
      const isAsk = card.kind === 'ask'
      const options = Array.isArray(card.options) ? card.options : []
      const [busy, setBusy] = React.useState(false)
      const [done, setDone] = React.useState('')
      const [error, setError] = React.useState('')
      const [resolving, setResolving] = React.useState(false)
      const [reason, setReason] = React.useState('')

      const submit = async (payload) => {
        if (busy) return
        setBusy(true)
        setError('')
        const res = await postJson('/autoloop/action', Object.assign({ id: card.id }, payload))
        setBusy(false)
        if (!res.ok) {
          setError((res.error && res.error.message) || t('unknownError'))
          return
        }
        setDone(payload.action === 'resolve' ? t('resolvedDone') : t('answered'))
        setResolving(false)
        props.onChanged()
      }

      const answer = (choice) => submit({ action: 'answer', choice })
      const markDone = () => submit({ action: 'answer', choice: 0 })
      const resolve = () => {
        const text = reason.trim()
        if (!text) return
        submit({ action: 'resolve', reason: text })
      }

      const meta = t('cardMeta', { id: card.id, rule: card.rule || '', time: fmtTime(card.createdAt) })
      return h(
        'div',
        { className: 'alp-card' },
        h(
          'div',
          { className: 'alp-card-top' },
          h('span', { className: 'alp-badge ' + (isAsk ? 'alp-badge-ask' : '') }, isAsk ? t('ask') : t('notice')),
          h('span', { className: 'alp-card-title' }, card.title || ''),
          h('span', { className: 'alp-meta' }, meta),
        ),
        card.text ? h('div', { className: 'alp-text' }, card.text) : null,
        isAsk && options.length
          ? h(
              'div',
              { className: 'alp-opts' },
              options.map((option, index) =>
                h(
                  'button',
                  {
                    key: index,
                    type: 'button',
                    className: 'alp-opt' + (card.recommend === index ? ' alp-opt-rec' : ''),
                    disabled: busy || Boolean(done),
                    onClick: () => answer(index),
                  },
                  h('span', null, option),
                  card.recommend === index ? h('span', { className: 'alp-opt-tag' }, t('recommended')) : null,
                ),
              ),
            )
          : null,
        !isAsk && !done
          ? h(
              'div',
              { className: 'alp-footrow' },
              h(
                'button',
                { type: 'button', className: 'alp-btn alp-btn-primary', disabled: busy, onClick: markDone },
                t('markDone'),
              ),
            )
          : null,
        isAsk && !done
          ? h(
              'div',
              null,
              resolving
                ? h(
                    'div',
                    { className: 'alp-footrow' },
                    h('input', {
                      className: 'alp-input',
                      value: reason,
                      maxLength: 1000,
                      placeholder: t('resolveHint'),
                      onChange: (event) => setReason(event.target.value),
                      onKeyDown: (event) => {
                        if (event.key === 'Enter') resolve()
                      },
                    }),
                    h(
                      'button',
                      { type: 'button', className: 'alp-btn alp-btn-primary', disabled: busy || !reason.trim(), onClick: resolve },
                      t('confirm'),
                    ),
                    h(
                      'button',
                      { type: 'button', className: 'alp-btn', disabled: busy, onClick: () => setResolving(false) },
                      t('cancel'),
                    ),
                  )
                : h(
                    'div',
                    { className: 'alp-footrow' },
                    h(
                      'button',
                      { type: 'button', className: 'alp-btn', disabled: busy, onClick: () => setResolving(true) },
                      t('resolve'),
                    ),
                  ),
            )
          : null,
        busy ? h('div', { className: 'alp-run-meta' }, t('acting')) : null,
        error ? h('div', { className: 'alp-err' }, error) : null,
        done ? h('div', { className: 'alp-ok' }, done) : null,
      )
    }

    function RunRow(props) {
      const t = props.t
      const run = props.run
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const active = run.state === 'queued' || run.state === 'claimed' || run.state === 'unknown'
      const tone = STATE_TONE[run.state] || C.sub
      const badgeClass =
        run.state === 'done'
          ? 'alp-badge alp-badge-done'
          : run.state === 'failed'
            ? 'alp-badge alp-badge-fail'
            : active
              ? 'alp-badge alp-badge-run'
              : 'alp-badge'
      const usage = run.usage || {}
      const tokens = (Number(usage.input) || 0) + (Number(usage.output) || 0)
      const duration = run.claimedAt ? elapsed(run.claimedAt, run.finishedAt ? new Date(run.finishedAt).getTime() : props.now) : ''

      const stop = async () => {
        if (busy) return
        setBusy(true)
        setError('')
        const res = await postJson('/autoloop/action', { action: 'cancel', id: run.id })
        setBusy(false)
        if (!res.ok) {
          setError((res.error && res.error.message) || t('unknownError'))
          return
        }
        props.onChanged()
      }

      const metaParts = []
      if (run.claimedAt) metaParts.push(t('duration', { s: duration }))
      if (tokens) metaParts.push(t('usage', { tokens: fmtTokens(tokens), cost: fmtMoney(usage.cost) }))
      if (Array.isArray(run.events) && run.events.length) metaParts.push(t('events', { n: run.events.length }))
      if (run.attempts > 0) metaParts.push(t('attempt', { n: run.attempts + 1 }))
      if (run.finishedAt) metaParts.push(fmtTime(run.finishedAt))

      return h(
        'div',
        { className: 'alp-run' },
        h(
          'div',
          { className: 'alp-run-top' },
          h('span', { className: badgeClass }, t(STATE_KEY[run.state] || 'stateUnknown')),
          h('span', { className: 'alp-run-name' }, t('runMeta', { id: run.id, rule: run.rule })),
          active
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'alp-btn',
                  style: { marginLeft: 'auto' },
                  disabled: busy || run.stopping,
                  title: t('stopHint'),
                  onClick: stop,
                },
                h(Icon, { name: 'stop', size: 12 }),
                run.stopping || busy ? t('stoppingAction') : t('stop'),
              )
            : h('span', { className: 'alp-meta' }, run.agent || ''),
        ),
        run.summary || run.error
          ? h('div', { className: 'alp-run-sub', style: run.error ? { color: C.error } : undefined }, run.error || run.summary)
          : null,
        metaParts.length ? h('div', { className: 'alp-run-meta' }, metaParts.map((part, index) => h('span', { key: index }, part))) : null,
        error ? h('div', { className: 'alp-err' }, error) : null,
      )
    }

    function SetupSteps(props) {
      const t = props.t
      return h(
        'div',
        { className: 'alp-steps' },
        h(
          'div',
          { className: 'alp-step' },
          h('div', { className: 'alp-step-label' }, t('install1')),
          h('div', { className: 'alp-code' }, 'curl -fsSL ' + RULE + ' | sh'),
        ),
        h(
          'div',
          { className: 'alp-step' },
          h('div', { className: 'alp-step-label' }, t('install2')),
          h('div', { className: 'alp-code' }, 'agent-autoloop up'),
        ),
        h(
          'div',
          { className: 'alp-step' },
          h('div', { className: 'alp-step-label' }, t('install3')),
          h('div', { className: 'alp-code' }, props.meta && props.meta.configPath ? props.meta.configPath : '~/.agent-autoloop/config.json'),
        ),
      )
    }

    function EmptyState(props) {
      return h(
        'div',
        { className: 'alp-empty-state' },
        h('div', { className: 'alp-empty-icon' }, props.icon ? h(Icon, { name: props.icon, size: 24 }) : h(Icon, { name: 'loop', size: 24 })),
        h('div', { className: 'alp-empty-title' }, props.title),
        props.body ? h('div', { className: 'alp-empty-body' }, props.body) : null,
        props.children || null,
      )
    }

    // ---------- Agents 工作台（数据来自 dsh-agent-observer 插件） ----------
    function useAgents(intervalMs) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null, updatedAt: 0 })
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        const load = async () => {
          const result = await getJson('/agents/summary')
          if (!alive) return
          if (result.ok) setState({ loading: false, data: result.data, error: null, updatedAt: Date.now() })
          else setState({ loading: false, data: null, error: result.error || { code: 'UNKNOWN', message: '' }, updatedAt: Date.now() })
        }
        load()
        const timer = setInterval(load, intervalMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [intervalMs, tick])
      const refresh = React.useCallback(() => setTick((n) => n + 1), [])
      return [state, refresh]
    }

    const agoText = (ageSec) => {
      const value = Number(ageSec)
      if (!Number.isFinite(value) || value < 0) return ''
      if (value < 60) return Math.max(1, Math.round(value)) + 's'
      if (value < 3600) return Math.floor(value / 60) + 'm'
      if (value < 86400) return Math.floor(value / 3600) + 'h'
      return Math.floor(value / 86400) + 'd'
    }

    const AGENT_GLYPH = { claude: '✳', codex: '⌘', dsh: '◈' }
    const STATUS_TONE = { working: C.success, idle: C.sub, offline: C.faint, error: C.error }
    const STATUS_KEY = { working: 'agentStatusWorking', idle: 'agentStatusIdle', offline: 'agentStatusOffline', error: 'agentStatusError' }

    function AgentStatus(props) {
      const t = props.t
      const status = props.status || 'idle'
      const tone = STATUS_TONE[status] || C.sub
      return h('span', { className: 'alp-status', style: { color: tone } }, h('span', { className: 'alp-status-dot', style: { background: tone } }), t(STATUS_KEY[status] || 'agentStatusIdle'))
    }

    function StepRows(props) {
      const t = props.t
      const steps = Array.isArray(props.steps) ? props.steps : []
      if (!steps.length) return h('div', { className: 'alp-agent-detail' }, t('agentNoSteps'))
      return h(
        'div',
        { className: 'alp-steps' },
        steps.map((step, index) =>
          h(
            'div',
            { className: 'alp-step-row', key: index },
            h('span', { className: 'alp-step-role' }, step.role || ''),
            h('span', { className: 'alp-step-text' }, (step.text || '') + (step.at ? '  ' + fmtTime(step.at) : '')),
          ),
        ),
      )
    }

    function AgentCard(props) {
      const t = props.t
      const agent = props.agent
      const [stepsOpen, setStepsOpen] = React.useState(false)
      const [steps, setSteps] = React.useState(null)
      const [stepsBusy, setStepsBusy] = React.useState(false)
      const [snapshot, setSnapshot] = React.useState(null)
      const [snapshotBusy, setSnapshotBusy] = React.useState(false)
      const [error, setError] = React.useState('')

      const toggleSteps = async () => {
        if (stepsOpen) {
          setStepsOpen(false)
          return
        }
        setStepsOpen(true)
        if (steps || stepsBusy) return
        setStepsBusy(true)
        const result = await getJson('/agents/' + encodeURIComponent(agent.id) + '/steps?limit=20')
        setStepsBusy(false)
        if (!result.ok) {
          setError((result.error && result.error.message) || t('unknownError'))
          return
        }
        setSteps(result.data.steps || [])
      }

      const grab = async () => {
        if (snapshotBusy) return
        setSnapshotBusy(true)
        setError('')
        const result = await postJson('/agents/' + encodeURIComponent(agent.id) + '/snapshot', {})
        setSnapshotBusy(false)
        if (!result.ok) {
          setError((result.error && result.error.message) || t('unknownError'))
          return
        }
        setSnapshot(result.data)
        props.onChanged()
      }

      const lastActive =
        agent.ageSec === null || agent.ageSec === undefined ? '' : agent.ageSec < 30 ? t('agentJustNow') : t('agentLastActive', { ago: agoText(agent.ageSec) })

      const metaParts = []
      if (agent.session && agent.session.title) metaParts.push(h('span', { key: 's' }, h('b', null, t('agentSession') + ' '), agent.session.title))
      if (agent.session && agent.session.cwd) metaParts.push(h('span', { key: 'c', title: agent.session.cwd }, agent.session.cwd))
      if (agent.window && agent.window.title) metaParts.push(h('span', { key: 'w' }, h('b', null, t('agentWindow') + ' '), agent.window.title))

      return h(
        'div',
        { className: 'alp-agent' },
        h(
          'div',
          { className: 'alp-agent-head' },
          h('span', { className: 'alp-agent-glyph' }, AGENT_GLYPH[agent.id] || '●'),
          h('span', { className: 'alp-agent-name' }, agent.name || agent.id),
          h('span', { className: 'alp-badge' }, agent.kind === 'gui' ? t('agentKindGui') : t('agentKindCode')),
          h(AgentStatus, { t, status: agent.status }),
          lastActive ? h('span', { className: 'alp-meta' }, lastActive) : null,
        ),
        h(
          'div',
          { className: 'alp-agent-body' },
          h('div', { className: 'alp-agent-step' }, agent.step || ''),
          agent.detail ? h('div', { className: 'alp-agent-detail' }, agent.detail) : null,
          metaParts.length ? h('div', { className: 'alp-agent-meta' }, metaParts) : null,
          Array.isArray(agent.outputs) && agent.outputs.length
            ? h(
                'div',
                { className: 'alp-agent-meta' },
                h('span', null, h('b', null, t('agentOutputs') + ' '), agent.outputs.map((item) => String(item.path || '').split('/').pop()).join(' · ')),
              )
            : null,
          h(
            'div',
            { className: 'alp-agent-actions' },
            h('button', { type: 'button', className: 'alp-btn', onClick: toggleSteps }, stepsOpen ? t('agentHide') : t('agentSteps')),
            agent.kind === 'gui' || agent.window
              ? h('button', { type: 'button', className: 'alp-btn', disabled: snapshotBusy, onClick: grab }, snapshotBusy ? t('agentGrabbing') : t('agentGrab'))
              : null,
          ),
          error ? h('div', { className: 'alp-err' }, error) : null,
          stepsOpen ? h('div', null, stepsBusy ? h('div', { className: 'alp-agent-detail' }, t('agentLoadSteps')) : h(StepRows, { t, steps })) : null,
          snapshot
            ? h(
                'div',
                { className: 'alp-snapshot' },
                snapshot.imageUrl ? h('img', { src: snapshot.imageUrl, alt: t('agentSnapshot') }) : null,
                h('div', { className: 'alp-agent-meta' }, t('agentSnapshotAt', { time: fmtTime(snapshot.at) })),
                snapshot.text ? h('pre', { className: 'alp-pre' }, snapshot.text) : null,
              )
            : agent.snapshotAt
              ? h('div', { className: 'alp-agent-meta' }, t('agentSnapshotAt', { time: fmtTime(agent.snapshotAt) }))
              : agent.kind === 'gui'
                ? h('div', { className: 'alp-agent-detail' }, t('agentSnapshotEmpty'))
                : null,
        ),
      )
    }

    function AgentsView(props) {
      const t = props.t
      const [state, refresh] = useAgents(10000)
      if (state.loading) return h('div', { className: 'alp-empty' }, t('agentLoading'))
      if (!state.data) {
        return h(
          EmptyState,
          { icon: 'spark', title: t('agentNoData'), body: t('agentNoDataHint') },
          state.error && state.error.message ? h('div', { className: 'alp-empty-body' }, state.error.message) : null,
          h('div', { style: { marginTop: 14 } }, h('button', { type: 'button', className: 'alp-btn', onClick: refresh }, h(Icon, { name: 'refresh', size: 13 }), t('retry'))),
        )
      }
      const agents = Array.isArray(state.data.agents) ? state.data.agents : []
      return h(
        'div',
        null,
        h(
          'div',
          { className: 'alp-agent-toolbar' },
          h('span', null, t('agentSub')),
          h('span', { style: { marginLeft: 'auto' } }, t('agentUpdated', { time: fmtClock(state.updatedAt) })),
          h('button', { type: 'button', className: 'alp-btn', onClick: refresh }, h(Icon, { name: 'refresh', size: 13 }), t('refresh')),
        ),
        h('div', { className: 'alp-agents', style: { marginTop: 10 } }, agents.map((agent) => h(AgentCard, { key: agent.id, agent, t, onChanged: refresh }))),
      )
    }

    function AutoloopPanel(props) {
      const t = props.t
      const [hub, refresh] = useHub(PANEL_INTERVAL)
      const now = Date.now()
      const [tab, setTab] = React.useState(() => {
        try {
          return window.localStorage.getItem('alp-tab') === 'agents' ? 'agents' : 'overview'
        } catch (error) {
          return 'overview'
        }
      })
      const switchTab = (next) => {
        setTab(next)
        try {
          window.localStorage.setItem('alp-tab', next)
        } catch (error) {
          /* 隐私模式下忽略 */
        }
      }

      const head = h(
        'div',
        { className: 'alp-head' },
        h('span', { className: 'alp-logo' }, h(Icon, { name: 'loop', size: 20 })),
        h(
          'div',
          { className: 'alp-headtext' },
          h('div', { className: 'alp-title' }, t('title')),
          h('div', { className: 'alp-sub' }, hub.meta && hub.meta.url ? hub.meta.url + ' · ' + t('subtitle') : t('subtitle')),
        ),
        h(
          'div',
          { className: 'alp-tools' },
          hub.loading
            ? h(Pill, { tone: C.dim }, t('connecting'))
            : hub.data
              ? h(Pill, { tone: C.success }, t('online'))
              : h(Pill, { tone: C.error }, t('errorTitle')),
          h(
            'button',
            { type: 'button', className: 'alp-btn', onClick: refresh, title: t('refresh') },
            h(Icon, { name: 'refresh', size: 13 }),
            t('refresh'),
          ),
        ),
      )

      const tabs = h(
        'div',
        { className: 'alp-tabs' },
        h('button', { type: 'button', className: 'alp-tab' + (tab === 'overview' ? ' alp-tab-on' : ''), onClick: () => switchTab('overview') }, t('tabsOverview')),
        h('button', { type: 'button', className: 'alp-tab' + (tab === 'agents' ? ' alp-tab-on' : ''), onClick: () => switchTab('agents') }, t('tabsAgents')),
      )

      if (tab === 'agents') {
        return h(
          'div',
          { className: 'alp-root' },
          h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          head,
          tabs,
          h('div', { className: 'alp-scroll' }, h(AgentsView, { t, onChanged: refresh })),
          h(
            'div',
            { className: 'alp-foot' },
            h('span', null, t('agentSub')),
            h('span', { style: { marginLeft: 'auto' } }, hub.meta && hub.meta.url ? hub.meta.url : ''),
          ),
        )
      }

      if (hub.loading) {
        return h('div', { className: 'alp-root' }, h('style', { dangerouslySetInnerHTML: { __html: CSS } }), head, tabs, h('div', { className: 'alp-empty' }, t('connecting')))
      }

      if (!hub.data) {
        const meta = hub.meta || {}
        const code = hub.error && hub.error.code
        const notInstalled = code === 'NOT_INSTALLED' || code === 'NO_OWNER' || code === 'BAD_CONFIG' || (meta && !meta.installed)
        const noOwner = code === 'NO_OWNER' || (meta && meta.installed && meta.hasOwner === false)
        return h(
          'div',
          { className: 'alp-root' },
          h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
          head,
          tabs,
          h(
            'div',
            { className: 'alp-scroll' },
            h(
              EmptyState,
              {
                title: notInstalled ? t('notInstalledTitle') : t('errorTitle'),
                body: notInstalled ? t('notInstalledBody') : (hub.error && hub.error.message) || t('unknownError'),
              },
              noOwner ? h('div', { className: 'alp-empty-body' }, t('noOwnerHint')) : null,
              notInstalled ? h(SetupSteps, { t, meta }) : null,
              h(
                'div',
                { style: { marginTop: 14 } },
                h(
                  'button',
                  { type: 'button', className: 'alp-btn', onClick: refresh },
                  h(Icon, { name: 'refresh', size: 13 }),
                  t('retry'),
                ),
              ),
            ),
          ),
        )
      }

      const state = hub.data
      const totals = state.totals || {}
      const spending = (state.spending && state.spending.today) || {}
      const cards = Array.isArray(state.cards) ? state.cards : []
      const runs = Array.isArray(state.runs) ? state.runs : []
      const agents = Array.isArray(state.agents) ? state.agents : []
      const channels = Array.isArray(state.channels) ? state.channels : []
      const rules = Array.isArray(state.lines) ? state.lines : []
      const elsewhere = Array.isArray(state.elsewhere) ? state.elsewhere : []
      const unrouted = Array.isArray(state.unrouted) ? state.unrouted : []
      const active = runs.filter((run) => run.state === 'queued' || run.state === 'claimed' || run.state === 'unknown')
      const finished = runs.filter((run) => !active.includes(run)).slice(0, 12)
      const onlineAgents = agents.filter((agent) => agent.online).length
      const onlineChannels = channels.filter((channel) => channel.online).length

      const sections = []

      sections.push(
        h(
          'div',
          { className: 'alp-section', key: 'cards' },
          h(SectionHead, { icon: 'spark', title: t('cardsTitle'), count: cards.length ? String(cards.length) : '' }),
          cards.length
            ? cards.map((card) => h(CardItem, { key: card.id, card, t, onChanged: refresh }))
            : h('div', { className: 'alp-empty' }, t('noCards')),
        ),
      )

      sections.push(
        h(
          'div',
          { className: 'alp-section', key: 'active' },
          h(SectionHead, {
            icon: 'loop',
            title: t('activeTitle'),
            count:
              (Number(totals.running) || 0) + (Number(totals.queued) || 0)
                ? t('running', { n: Number(totals.running) || 0 }) + ' · ' + t('queued', { n: Number(totals.queued) || 0 })
                : '',
          }),
          active.length
            ? active.map((run) => h(RunRow, { key: run.id, run, t, now, onChanged: refresh }))
            : h('div', { className: 'alp-empty' }, t('noActive')),
        ),
      )

      sections.push(
        h(
          'div',
          { className: 'alp-section', key: 'recent' },
          h(SectionHead, { icon: 'refresh', title: t('recentTitle') }),
          finished.length
            ? finished.map((run) => h(RunRow, { key: run.id, run, t, now, onChanged: refresh }))
            : h('div', { className: 'alp-empty' }, t('noRecent')),
        ),
      )

      if (agents.length || channels.length) {
        sections.push(
          h(
            'div',
            { className: 'alp-section', key: 'members' },
            h(SectionHead, {
              icon: 'loop',
              title: t('membersTitle'),
              count: 'Agent ' + onlineAgents + '/' + agents.length + ' · ' + onlineChannels + '/' + channels.length,
            }),
            h(
              'div',
              { className: 'alp-chips' },
              agents.map((agent) =>
                h(
                  'span',
                  { className: 'alp-chip', key: 'agent-' + agent.id },
                  h(Dot, { online: agent.online, offline: !agent.online }),
                  h('span', null, agent.name || agent.id),
                  h('span', { style: { color: C.faint } }, agent.use || ''),
                ),
              ),
              channels.map((channel) =>
                h(
                  'span',
                  { className: 'alp-chip', key: 'channel-' + channel.id },
                  h(Dot, { online: channel.online, offline: !channel.online }),
                  h('span', null, channel.name || channel.id),
                  h('span', { style: { color: C.faint } }, 'channel'),
                ),
              ),
            ),
          ),
        )
      }

      if (rules.length || elsewhere.length) {
        sections.push(
          h(
            'div',
            { className: 'alp-section', key: 'rules' },
            h(SectionHead, { icon: 'spark', title: t('rulesTitle'), count: String(rules.length) }),
            rules.map((rule) => {
              const trigger = rule.types && rule.types.length ? t('ruleEvent', { types: rule.types.join(', ') }) : t('ruleCron', { every: rule.every || '' })
              const nextText = rule.next ? t('ruleNext', { time: fmtTime(rule.next) }) : ''
              return h(
                'div',
                { className: 'alp-rule', key: 'rule-' + rule.id },
                h('span', { className: 'alp-rule-name' }, rule.name || rule.id),
                h('span', { className: 'alp-badge' }, rule.agent || ''),
                h('span', { style: { color: C.sub, fontSize: 12 } }, trigger),
                h('span', { className: 'alp-rule-meta' }, nextText),
              )
            }),
            elsewhere.length
              ? h(
                  'div',
                  null,
                  h('div', { className: 'alp-section-head', style: { borderTop: '1px solid ' + C.border } }, t('elsewhereTitle')),
                  elsewhere.map((task) =>
                    h(
                      'div',
                      { className: 'alp-rule', key: 'elsewhere-' + task.id },
                      h('span', { className: 'alp-rule-name' }, task.name || task.id),
                      h('span', { style: { color: C.sub, fontSize: 12 } }, task.where || ''),
                      h('span', { className: 'alp-rule-meta' }, task.next ? t('ruleNext', { time: fmtTime(task.next) }) : ''),
                    ),
                  ),
                )
              : null,
          ),
        )
      }

      if (unrouted.length) {
        sections.push(
          h(
            'div',
            { className: 'alp-section', key: 'unrouted' },
            h(SectionHead, { icon: 'spark', title: t('unroutedTitle'), count: String(unrouted.length) }),
            unrouted.slice(0, 8).map((event) =>
              h(
                'div',
                { className: 'alp-rule', key: 'unrouted-' + event.id },
                h('span', { className: 'alp-badge' }, event.source || ''),
                h('span', { style: { fontSize: 12 } }, (event.type || '') + (event.subject ? ' · ' + event.subject : '')),
                h('span', { className: 'alp-rule-meta' }, fmtTime(event.received_at || event.receivedAt)),
              ),
            ),
          ),
        )
      }

      return h(
        'div',
        { className: 'alp-root' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        head,
        tabs,
        h('div', { className: 'alp-scroll' }, sections),
        h(
          'div',
          { className: 'alp-foot' },
          h('span', null, t('rulesFileHint')),
          h('span', { style: { marginLeft: 'auto' } }, t('updated', { time: fmtClock(hub.updatedAt) })),
          h(
            'span',
            null,
            t('todayLine', {
              rounds: fmtTokens(spending.rounds),
              tokens: fmtTokens(spending.tokens),
              cost: fmtMoney(spending.cost),
            }),
          ),
        ),
      )
    }

    function SidebarIcon(props) {
      const size = props.size || 18
      const [hub] = useHub(ICON_INTERVAL)
      const attention = hub && hub.data && hub.data.totals ? Number(hub.data.totals.attention) || 0 : 0
      const offline = hub && !hub.loading && !hub.data
      const stroke = props.active ? '#fff' : 'currentColor'
      return h(
        'span',
        { style: { position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size, height: size } },
        h(
          'svg',
          { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
          props.active
            ? h('rect', { x: 1.6, y: 1.6, width: 20.8, height: 20.8, rx: 6, fill: C.brand })
            : null,
          h('path', { d: 'M19 12a7 7 0 0 1-11.8 5', stroke, strokeWidth: 1.7, strokeLinecap: 'round' }),
          h('path', { d: 'M5 12a7 7 0 0 1 11.8-5', stroke, strokeWidth: 1.7, strokeLinecap: 'round' }),
          h('path', { d: 'M16.4 3.6v3.8h-3.8M7.6 20.4v-3.8h3.8', stroke, strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        ),
        attention > 0
          ? h(
              'span',
              {
                style: {
                  position: 'absolute',
                  top: -3,
                  right: -4,
                  minWidth: 14,
                  height: 14,
                  padding: '0 4px',
                  borderRadius: 999,
                  background: C.error,
                  color: '#fff',
                  fontSize: 9,
                  fontWeight: 700,
                  lineHeight: '14px',
                  textAlign: 'center',
                  boxShadow: '0 0 0 2px var(--dsw-specific-sidebar-fill, ' + C.bg + ')',
                },
              },
              attention > 9 ? '9+' : String(attention),
            )
          : offline
            ? h('span', {
                style: {
                  position: 'absolute',
                  top: -2,
                  right: -4,
                  width: 7,
                  height: 7,
                  borderRadius: 999,
                  background: C.dim,
                  boxShadow: '0 0 0 2px var(--dsw-specific-sidebar-fill, ' + C.bg + ')',
                },
              })
            : null,
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'autoloop: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'autoloop', locale: NS, inject: () => ({ t }) }, AutoloopPanel))

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register({ name: 'sidebar.panellist', id: 'autoloop', order: 30, locale: NS, label: () => t('nav') }, SidebarIcon),
      )
    }

    exports.name = 'autoloop-panel'
    exports.inject = ['slots', 'locale', 'layout']
    exports.apply = apply
    return module.exports
  },
})
