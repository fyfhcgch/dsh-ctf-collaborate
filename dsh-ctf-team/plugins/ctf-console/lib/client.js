/**
 * dsh-ctf-console — CTF 解题控制台（Client 半）。AMD module via __ModuleLoader__.
 * Auto-wrapped from the authoring ESM (see client.js.esm.bak).
 */
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-ctf-console',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
const name = 'ctf-console'
const inject = ['slots']

const css =
  '.ctfcon-panel{display:flex;flex-direction:column;height:100%;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}' +
  '.ctfcon-ptitle{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);font-weight:600;font-size:14px;flex:0 0 auto}' +
  '.ctfcon-pbody{padding:12px;overflow-y:auto;display:flex;flex-direction:column;gap:10px;flex:1 1 auto}' +
  '.ctfcon-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1)}' +
  '.ctfcon-sec{font-weight:600;font-size:13px;margin-bottom:8px}' +
  '.ctfcon-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
  '.ctfcon-btn{padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer;font-size:13px}' +
  '.ctfcon-btn:hover{border-color:var(--dsw-alias-brand-primary)}' +
  '.ctfcon-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}' +
  '.ctfcon-btn:disabled{opacity:.5;cursor:not-allowed}' +
  '.ctfcon-icon{background:transparent;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:16px;line-height:1;padding:2px 6px;border-radius:6px}' +
  '.ctfcon-icon:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}' +
  '.ctfcon-icon.close:hover{color:var(--dsw-alias-state-error-primary)}' +
  '.ctfcon-input{padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font-size:13px;width:100%;box-sizing:border-box}' +
  '.ctfcon-muted{color:var(--dsw-alias-label-secondary);font-size:12px}' +
  '.ctfcon-item{display:flex;gap:8px;align-items:center;padding:6px 8px;border-radius:6px;cursor:pointer;font-size:13px}' +
  '.ctfcon-item:hover{background:var(--dsw-alias-bg-layer-2)}' +
  '.ctfcon-item.active{background:rgba(59,130,246,.18)}' +
  '.ctfcon-log{font-family:ui-monospace,monospace;font-size:12px;max-height:180px;overflow-y:auto;line-height:1.6}' +
  '.ctfcon-a{color:var(--dsw-alias-brand-primary);font-size:13px;margin-right:10px;text-decoration:none}' +
  '.ctfcon-a:hover{text-decoration:underline}' +
  '.ctfcon-pre{white-space:pre-wrap;font-size:13px;margin:0 0 8px;color:var(--dsw-alias-label-primary)}'

function apply(ctx) {
  const React = require('react')
  const h = React.createElement
  const slots = ctx.slots

  // Inject plugin stylesheet directly (dsh clients do not expose ctx.styles).
  if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dsh-ctf-console"]') === null) {
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin-css', 'dsh-ctf-console')
    tag.textContent = css
    document.head.appendChild(tag)
  }

  function el(tag, props) {
    const children = Array.prototype.slice.call(arguments, 2)
    return h.apply(null, [tag, props || null].concat(children))
  }
  function elc(tag, cls) {
    const children = Array.prototype.slice.call(arguments, 2)
    return h.apply(null, [tag, { className: cls }].concat(children))
  }

  async function call(action, args) {
    try {
      const res = await fetch('/api/ctf-console/' + encodeURIComponent(action), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args ?? {}),
      })
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        return { ok: false, error: '非 JSON 响应: ' + text.slice(0, 200) }
      }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }

  let panelDisposer = null
  let latestInputActions = null
  let latestSessionId = ''

  function captureInputActions(props) {
    if (props && props.inputActions && typeof props.inputActions.setDraft === 'function' && typeof props.inputActions.submit === 'function') {
      latestInputActions = props.inputActions
      latestSessionId = String(props.sessionId || '')
    }
  }

  function openPanel() {
    if (!panelDisposer) {
      panelDisposer = slots.inject('details', function () {
        return slots.register({ name: 'details', priority: -1 }, function () {
          return el(Panel)
        })
      })
    }
    const layout = ctx.get('layout')
    if (layout) layout.openDetails()
  }
  function closePanel() {
    const layout = ctx.get('layout')
    if (layout) layout.closeDetails()
    if (panelDisposer) {
      panelDisposer()
      panelDisposer = null
    }
  }

  function FooterButton(props) {
    const wide = props && props.wide === true
    const base = {
      cursor: 'pointer',
      fontFamily: 'inherit',
      color: 'var(--dsw-alias-label-primary, #e5e7eb)',
      boxSizing: 'border-box',
      background: 'transparent',
      outline: 'none',
    }
    if (!wide) {
      return h(
        'button',
        {
          type: 'button',
          title: 'CTF 解题控制台',
          'aria-label': 'CTF 解题控制台',
          onClick: openPanel,
          style: Object.assign({}, base, {
            width: 36,
            height: 36,
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            padding: 0,
            border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.25))',
          }),
        },
        '🖥️'
      )
    }
    return h(
      'button',
      {
        type: 'button',
        title: '打开 CTF 解题控制台',
        onClick: openPanel,
        style: Object.assign({}, base, {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          height: 42,
          borderRadius: 12,
          padding: '0 10px',
          fontSize: 14,
          textAlign: 'left',
          border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.25))',
        }),
      },
      h('span', { style: { fontSize: 16, lineHeight: 1, flex: 'none' } }, '🖥️'),
      h('span', { style: { textOverflow: 'ellipsis', whiteSpace: 'nowrap', overflow: 'hidden', minWidth: 0 } }, 'CTF 控制台')
    )
  }

  function HeaderButton(props) {
    captureInputActions(props)
    return h(
      'button',
      {
        type: 'button',
        title: '打开 CTF 解题控制台',
        'aria-label': 'CTF 解题控制台',
        onClick: openPanel,
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          height: 28,
          padding: '0 8px',
          borderRadius: 6,
          border: '1px solid var(--dsw-alias-border-l2, rgba(255,255,255,0.25))',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary, #e5e7eb)',
          fontSize: 12,
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
      },
      '🖥️ CTF'
    )
  }

  function Panel() {
    const [serverHost, setServerHost] = React.useState('')
    const [accessKey, setAccessKey] = React.useState('')
    const [status, setStatus] = React.useState({ serverHost: '', hasKey: false, transport: '' })
    const [categories, setCategories] = React.useState(null)
    const [selected, setSelected] = React.useState(null)
    const [detail, setDetail] = React.useState(null)
    const [overview, setOverview] = React.useState(null)
    const [notices, setNotices] = React.useState(null)
    const [flagInput, setFlagInput] = React.useState('')
    const [log, setLog] = React.useState([])
    const [busy, setBusy] = React.useState(false)
    const [role, setRole] = React.useState(function () { return localStorage.getItem('ctf-console.role') || 'leader' })
    const [memberName, setMemberName] = React.useState(function () { return localStorage.getItem('ctf-console.member') || '队长' })
    const [teamChallenges, setTeamChallenges] = React.useState([])
    const [candidateFlag, setCandidateFlag] = React.useState('')
    const [candidateNote, setCandidateNote] = React.useState('')

    React.useEffect(function () {
      call('status').then(function (s) {
        setStatus(s)
        setServerHost(s.serverHost || '')
      })
    }, [])
    React.useEffect(function () { localStorage.setItem('ctf-console.role', role) }, [role])
    React.useEffect(function () { localStorage.setItem('ctf-console.member', memberName) }, [memberName])

    function addLog(kind, msg) {
      setLog(function (prev) {
        return [{ kind: kind, msg: String(msg), t: Date.now() }].concat(prev).slice(0, 40)
      })
    }
    function run(method, args, okMsg) {
      setBusy(true)
      return call(method, args || {})
        .then(function (res) {
          setBusy(false)
          if (res && res.ok && res.code === '00000') {
            addLog('ok', okMsg || method)
            return res
          }
          const err = res && res.error ? res.error : res && res.message ? res.message : '请求失败'
          addLog('err', err)
          return null
        })
        .catch(function (e) {
          setBusy(false)
          addLog('err', String((e && e.message) || e))
          return null
        })
    }
    function pollDetail(id, n) {
      const attempt = n || 0
      call('detail', { exerciseId: id })
        .then(function (res) {
          if (res && res.ok && res.code === '00000') {
            const d = res.data
            setDetail(d)
            if (d && d.isNeedCheck && attempt < 8) {
              setTimeout(function () {
                pollDetail(id, attempt + 1)
              }, 2500)
            } else if (attempt > 0) {
              addLog('ok', '环境已就绪')
            }
          } else {
            addLog('err', res && res.error ? res.error : '环境状态查询失败')
          }
        })
        .catch(function (e) {
          addLog('err', String((e && e.message) || e))
        })
    }

    async function syncBoardConfig(nextServerHost, nextAccessKey) {
      const res = await fetch('/ctf-team/api/platform/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverHost: nextServerHost, accessKey: nextAccessKey }),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error('CTF Board 平台配置同步失败: ' + text.slice(0, 200))
      }
      return res.json()
    }
    function saveConfig() {
      call('configure', { serverHost: serverHost, accessKey: accessKey }).then(function (s) {
        setStatus(s)
        addLog('ok', '控制台配置已保存' + (s.hasKey ? '（含 AccessKey）' : ''))
        syncBoardConfig(serverHost, accessKey).then(function () {
          addLog('ok', 'CTF Board 平台配置已同步')
        }).catch(function (e) {
          addLog('err', String((e && e.message) || e))
        })
      })
    }
    function loadList() {
      run('list', {}, '题目列表已加载').then(function (res) {
        if (res) setCategories(res.data || [])
      })
    }
    function loadOverview() {
      run('overview', {}, '得分排名已加载').then(function (res) {
        if (res) setOverview(res.data || null)
      })
    }
    function loadNotices() {
      run('notices', {}, '公告已加载').then(function (res) {
        if (res) setNotices(res.data || null)
      })
    }
    function openDetail(id) {
      setSelected(id)
      setDetail(null)
      setFlagInput('')
      run('detail', { exerciseId: id }, '题目详情已加载').then(function (res) {
        if (res) setDetail(res.data || null)
      })
    }
    function build(id) {
      run('build', { exerciseId: id }, '环境启动请求已提交（异步）').then(function (res) {
        if (res) setTimeout(function () { pollDetail(id, 0) }, 2000)
      })
    }
    function recover(id) {
      run('recover', { exerciseId: id }, '环境回收请求已提交').then(function () {
        setTimeout(function () { openDetail(id) }, 1500)
      })
    }
    function boardCategory(raw) {
      const value = String(raw || '').toLowerCase()
      if (value === 'reverse') return 'rev'
      if (value === 'forensics') return 'forensic'
      if (['web', 'pwn', 'crypto', 'rev', 'misc', 'forensic'].indexOf(value) >= 0) return value
      return 'misc'
    }
    function boardChallengePayload(d, solveData) {
      const id = 'dasctf-' + String(d.id || Date.now()).replace(/[^A-Za-z0-9_-]/g, '-')
      const files = d.attachment && Array.isArray(d.attachment.files) ? d.attachment.files : []
      return {
        challengeId: id,
        title: String(d.name || ('DASCTF #' + (d.id || 'unknown'))),
        category: boardCategory((solveData && solveData.category) || d.category),
        status: 'solving',
        description: JSON.stringify({ exercise: d, planner: solveData || null }, null, 2),
        attachmentPaths: files.map(function (f) { return String(f.url || f.name || '') }).filter(Boolean),
      }
    }
    async function syncBoardChallenge(d, solveData) {
      const payload = boardChallengePayload(d, solveData)
      const create = await fetch('/ctf-team/api/challenges', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (create.ok) return { action: 'created', challengeId: payload.challengeId }
      if (create.status === 409) {
        const update = await fetch('/ctf-team/api/challenges/' + encodeURIComponent(payload.challengeId) + '/update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: payload.title,
            category: payload.category,
            status: payload.status,
            description: payload.description,
            attachmentPaths: payload.attachmentPaths,
          }),
        })
        if (update.ok) return { action: 'updated', challengeId: payload.challengeId }
        const error = await update.text()
        throw new Error('CTF Board 更新失败: ' + error.slice(0, 200))
      }
      const error = await create.text()
      throw new Error('CTF Board 创建失败: ' + error.slice(0, 200))
    }
    function conversationPromptForAgent(d, boardInfo, solveData) {
      const files = d.attachment && Array.isArray(d.attachment.files) ? d.attachment.files : []
      const endpoints = Array.isArray(d.endpoints) ? d.endpoints : []
      return [
        '请直接接管并开始解这道 CTF Web 题，不要只说流程。',
        '',
        '题目：' + String(d.name || boardInfo.challengeId),
        'exerciseId：' + String(d.id || ''),
        'challengeId：' + String(boardInfo.challengeId || ''),
        solveData && solveData.planId ? '自动化流水线 planId：' + String(solveData.planId) : '',
        solveData && solveData.category ? '流水线分类：' + String(solveData.category) : '',
        '难度：' + String(d.difficulty || ''),
        '分值：' + String(d.score || ''),
        '',
        '题目描述：',
        String(d.description || ''),
        '',
        endpoints.length ? '靶机/端点：\n' + endpoints.map(function (ep, i) {
          return '- #' + (i + 1) + ' IP=' + (ep.exposeIps || []).join(',') + ' ports=' + (ep.ports || []).join(',') + ' mappings=' + (ep.portMappings || []).map(function (m) { return String(m.port || '') + '->' + String(m.proxy || '') }).join(',')
        }).join('\n') : '靶机/端点：无',
        '',
        files.length ? '附件：\n' + files.map(function (f) { return '- ' + String(f.name || '') + ': ' + String(f.url || '') }).join('\n') : '附件：无',
        '',
        '要求：',
        '1. 现在就在当前对话里开始实际解题；',
        '2. 先做信息收集和漏洞假设，再用可用工具验证；',
        '3. 若拿到 flag，提交时只提交 {} 内内容；',
        '4. 同步把关键证据/思路写入 CTF Board（如可行）。',
      ].filter(function (line) { return line !== '' || true }).join('\n')
    }
    function submitToCurrentConversation(prompt) {
      if (!latestInputActions || typeof latestInputActions.setDraft !== 'function' || typeof latestInputActions.submit !== 'function') return false
      latestInputActions.setDraft(prompt)
      setTimeout(function () {
        latestInputActions.submit()
      }, 0)
      return true
    }
    function parseBoardExercise(challenge) {
      try {
        const parsed = JSON.parse(challenge.description || '{}')
        return parsed && parsed.exercise ? parsed.exercise : null
      } catch (_) {
        return null
      }
    }
    function boardIdForExerciseId(id) {
      return 'dasctf-' + String(id || '').replace(/[^A-Za-z0-9_-]/g, '-')
    }
    async function syncTeamChallenges() {
      const res = await fetch('/ctf-team/api/challenges')
      if (!res.ok) throw new Error('同步队伍题目失败: ' + (await res.text()).slice(0, 200))
      const list = await res.json()
      setTeamChallenges(Array.isArray(list) ? list : [])
      addLog('ok', '已同步队伍题目：' + (Array.isArray(list) ? list.length : 0) + ' 道')
      return list
    }
    async function leaderPublishLoadedChallenges() {
      if (!flat.length) {
        addLog('warn', '请先由队长加载平台题目')
        return
      }
      setBusy(true)
      try {
        let count = 0
        for (const x of flat) {
          const fakeDetail = Object.assign({}, x, { name: x.name || x.title, description: x.description || '', attachment: x.attachment || { files: [] }, endpoints: x.endpoints || [] })
          await syncBoardChallenge(fakeDetail, null)
          count += 1
        }
        addLog('ok', '队长已发布题库到 CTF Board：' + count + ' 道')
        await syncTeamChallenges()
      } catch (e) {
        addLog('err', String((e && e.message) || e))
      } finally {
        setBusy(false)
      }
    }
    async function openTeamChallenge(challengeId) {
      setBusy(true)
      try {
        const res = await fetch('/ctf-team/api/challenges/' + encodeURIComponent(challengeId))
        if (!res.ok) throw new Error('读取队伍题目失败: ' + (await res.text()).slice(0, 200))
        const data = await res.json()
        const exercise = parseBoardExercise(data.challenge)
        if (exercise) {
          setSelected(exercise.id)
          setDetail(exercise)
          setFlagInput(data.challenge.flag || '')
          addLog('ok', '已打开队伍题目：' + data.challenge.title)
        } else {
          addLog('warn', '该 Board 题目没有平台 exercise 详情，请由队长重新同步')
        }
      } catch (e) {
        addLog('err', String((e && e.message) || e))
      } finally {
        setBusy(false)
      }
    }
    async function submitCandidateFlag() {
      const flag = candidateFlag.trim()
      if (!detail) return addLog('warn', '请先选择题目')
      if (!flag) return addLog('warn', '请先填写候选 flag')
      const challengeId = boardIdForExerciseId(detail.id)
      setBusy(true)
      try {
        await syncBoardChallenge(detail, null)
        const content = JSON.stringify({ kind: 'candidate_flag', member: memberName || '队员', exerciseId: detail.id, title: detail.name, flag: flag, note: candidateNote.trim(), createdAt: Date.now() }, null, 2)
        await postBoard('/evidence', { challengeId: challengeId, type: 'log', content: content })
        await postBoard('/notes', { challengeId: challengeId, authorUserId: memberName || '队员', content: '[候选 flag] ' + flag + (candidateNote.trim() ? '\n' + candidateNote.trim() : '') })
        await postBoard('/challenges/' + encodeURIComponent(challengeId) + '/update', { flag: flag, status: 'solving' })
        setFlagInput(flag)
        setCandidateFlag('')
        setCandidateNote('')
        addLog('ok', '候选 flag 已汇总到队长：' + challengeId)
        await syncTeamChallenges()
      } catch (e) {
        addLog('err', String((e && e.message) || e))
      } finally {
        setBusy(false)
      }
    }
    async function postBoard(path, body) {
      const res = await fetch('/ctf-team/api' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) {
        const text = await res.text()
        throw new Error('CTF Board API 失败 ' + path + ': ' + text.slice(0, 200))
      }
      return res.json()
    }
    function startSolving() {
      if (!detail) {
        addLog('warn', '请先选择题目')
        return
      }
      setBusy(true)
      ;(async function () {
        const solveRes = await call('solve', { exerciseId: detail.id, detail: detail })
        if (!solveRes || !solveRes.ok || solveRes.code !== '00000') {
          throw new Error((solveRes && (solveRes.error || solveRes.message)) || '自动化解题流水线启动失败')
        }
        addLog('ok', '自动化解题流水线已启动：' + solveRes.data.planId + (solveRes.data.category ? ' · ' + solveRes.data.category : ''))
        const info = await syncBoardChallenge(detail, solveRes.data)
        addLog('ok', 'CTF Board 已' + (info.action === 'created' ? '创建' : '更新') + '：' + info.challengeId)
        try {
          await postBoard('/platform/exercise/sync', { exerciseId: detail.id })
          addLog('ok', 'CTF Board 单题平台数据已同步')
        } catch (e) {
          addLog('warn', String((e && e.message) || e))
        }
        addLog('ok', '主流程：Planner → 多专家 → Blackboard → Verifier；Board 仅作可视化登记')
        const submitted = submitToCurrentConversation(conversationPromptForAgent(detail, info, solveRes.data))
        addLog(submitted ? 'ok' : 'warn', submitted ? '已自动提交到当前对话，开始由我接管解题' : '无法自动提交到当前对话：请从会话头部 🖥️ CTF 入口打开一次控制台')
      })().catch(function (e) {
        addLog('err', String((e && e.message) || e))
      }).finally(function () {
        setBusy(false)
      })
    }
    function submit(id) {
      const flag = flagInput.trim()
      if (!flag) {
        addLog('warn', '请先输入 flag')
        return
      }
      run('submit', { exerciseId: id, flag: flag }, 'flag 已提交').then(function (res) {
        if (res) {
          const ok = res.data && res.data.isCorrect
          addLog(ok ? 'ok' : 'warn', '判定: ' + (ok ? '正确 ✓' : '错误 ✗'))
          if (ok) {
            setFlagInput('')
            openDetail(id)
          }
        }
      })
    }

    const flat = []
    ;(categories || []).forEach(function (c) {
      ;(c.corpus || []).forEach(function (x) {
        flat.push(Object.assign({}, x, { category: c.name }))
      })
    })
    const solvedCount = flat.filter(function (x) {
      return x.hasSolved
    }).length

    return elc(
      'div',
      'ctfcon-panel',
      elc(
        'div',
        'ctfcon-ptitle',
        el('span', null, '🖥️'),
        el('span', { style: { flex: 1 } }, 'CTF 解题控制台'),
        el('button', { className: 'ctfcon-icon', title: '最小化', onClick: closePanel }, '—'),
        el('button', { className: 'ctfcon-icon close', title: '关闭', onClick: closePanel }, '×')
      ),
      elc(
        'div',
        'ctfcon-pbody',
        elc(
          'div',
          'ctfcon-card',
          elc('div', 'ctfcon-sec', '配置'),
          el(
            'div',
            { className: 'ctfcon-row', style: { marginBottom: 6 } },
            el('input', {
              className: 'ctfcon-input',
              style: { flex: 2 },
              value: serverHost,
              placeholder: 'serverHost（如 https://pro.dasctf.com）',
              onChange: function (e) {
                setServerHost(e.target.value)
              },
            }),
            el('input', {
              className: 'ctfcon-input',
              style: { flex: 1 },
              value: accessKey,
              type: 'password',
              placeholder: 'AccessKey',
              onChange: function (e) {
                setAccessKey(e.target.value)
              },
            }),
            el('button', { className: 'ctfcon-btn primary', onClick: saveConfig }, '保存')
          ),
          el(
            'div',
            { className: 'ctfcon-muted' },
            status.hasKey
              ? '已配置：' + status.serverHost + '（含 AccessKey）· 通道 ' + status.transport
              : '凭据仅保存在插件内存，不持久化。'
          )
        ),
        elc(
          'div',
          'ctfcon-card',
          elc('div', 'ctfcon-sec', '队伍协作'),
          el(
            'div',
            { className: 'ctfcon-row', style: { marginBottom: 6 } },
            el('select', {
              className: 'ctfcon-input',
              style: { maxWidth: 120 },
              value: role,
              onChange: function (e) { setRole(e.target.value) },
            }, el('option', { value: 'leader' }, '队长'), el('option', { value: 'member' }, '队员')),
            el('input', {
              className: 'ctfcon-input',
              style: { flex: 1 },
              value: memberName,
              placeholder: role === 'leader' ? '队长名称' : '队员名称',
              onChange: function (e) { setMemberName(e.target.value) },
            }),
            el('button', { className: 'ctfcon-btn', disabled: busy, onClick: syncTeamChallenges }, '同步队伍题目'),
            role === 'leader' ? el('button', { className: 'ctfcon-btn primary', disabled: busy, onClick: leaderPublishLoadedChallenges }, '队长发布题库') : null
          ),
          el('div', { className: 'ctfcon-muted', style: { marginBottom: 6 } }, role === 'leader' ? '队长负责加载平台题目、发布题库、汇总并提交最终 flag。' : '队员从队长同步题目，独立解题并把候选 flag 汇总给队长。'),
          teamChallenges.length ? el(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 150, overflow: 'auto' } },
            teamChallenges.map(function (ch) {
              return el('div', { key: ch.challengeId, className: 'ctfcon-item', onClick: function () { openTeamChallenge(ch.challengeId) } },
                el('span', null, (ch.status === 'solved' ? '✅ ' : ch.flag ? '🚩 ' : '⬜ ') + ch.title),
                el('span', { className: 'ctfcon-muted' }, ch.category + ' · ' + ch.challengeId + (ch.flag ? ' · 有候选 flag' : ''))
              )
            })
          ) : el('div', { className: 'ctfcon-muted' }, '暂无队伍题目；队长先加载平台题目后点击「队长发布题库」。')
        ),
        elc(
          'div',
          'ctfcon-card',
          el(
            'div',
            { className: 'ctfcon-row' },
            el('button', { className: 'ctfcon-btn primary', disabled: busy, onClick: loadList }, '加载题目'),
            el('button', { className: 'ctfcon-btn', disabled: busy, onClick: loadOverview }, '得分/排名'),
            el('button', { className: 'ctfcon-btn', disabled: busy, onClick: loadNotices }, '公告')
          ),
          overview
            ? el(
                'div',
                { className: 'ctfcon-muted', style: { marginTop: 6 } },
                '得分 ' + overview.stagePoint + ' · 排名 ' + overview.stageRank
              )
            : null,
          notices
            ? el(
                'div',
                { className: 'ctfcon-muted', style: { marginTop: 6, whiteSpace: 'pre-wrap' } },
                (notices.note ? '注意事项：' + notices.note + '\n' : '') + (notices.rule ? '规则：' + notices.rule : '')
              )
            : null
        ),
        elc(
          'div',
          'ctfcon-card',
          elc('div', 'ctfcon-sec', flat.length ? '题目（' + flat.length + ' · 已解 ' + solvedCount + '）' : '题目'),
          flat.length
            ? el(
                'div',
                { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                flat.map(function (x) {
                  return el(
                    'div',
                    {
                      key: x.id,
                      className: 'ctfcon-item' + (selected === x.id ? ' active' : ''),
                      onClick: function () {
                        openDetail(x.id)
                      },
                    },
                    el('span', null, (x.hasSolved ? '✅' : '⬜') + ' ' + x.name),
                    el('span', { className: 'ctfcon-muted' }, x.category + ' · #' + x.id)
                  )
                })
              )
            : el('div', { className: 'ctfcon-muted' }, '点击「加载题目」开始')
        ),
        detail
          ? elc(
              'div',
              'ctfcon-card',
              elc('div', 'ctfcon-sec', '详情 · ' + detail.name + '（#' + detail.id + '）'),
              el(
                'div',
                { className: 'ctfcon-muted', style: { marginBottom: 6 } },
                '难度 ' + (detail.difficulty || '-') + ' · 分值 ' + (detail.score || '-') + (detail.hasSolved ? ' · ✅ 已解' : '')
              ),
              el(
                'div',
                { className: 'ctfcon-muted', style: { marginBottom: 6 } },
                detail.isNeedInit
                  ? '⚠️ 需先启动环境'
                  : detail.isNeedCheck
                    ? '⏳ 环境准备中…'
                    : '✅ 环境可用'
              ),
              detail.description ? el('pre', { className: 'ctfcon-pre' }, detail.description) : null,
              detail.attachment && detail.attachment.files && detail.attachment.files.length
                ? el(
                    'div',
                    { style: { marginBottom: 8 } },
                    elc('div', 'ctfcon-sec', '附件'),
                    detail.attachment.files.map(function (f, i) {
                      return el('a', { key: i, className: 'ctfcon-a', href: f.url, target: '_blank' }, f.name)
                    })
                  )
                : null,
              detail.endpoints && detail.endpoints.length
                ? el(
                    'div',
                    { style: { marginBottom: 8 } },
                    elc('div', 'ctfcon-sec', '靶机'),
                    detail.endpoints.map(function (ep, i) {
                      const users = (ep.users || [])
                        .map(function (u) {
                          return u.username + '/' + u.password
                        })
                        .join(', ')
                      const maps = (ep.portMappings || [])
                        .map(function (m) {
                          return m.port + '→' + m.proxy
                        })
                        .join(', ')
                      return el(
                        'div',
                        { key: i, className: 'ctfcon-muted' },
                        'IP ' + (ep.exposeIps || []).join(',') +
                          ' · 端口 ' + (ep.ports || []).join(',') +
                          (users ? ' · 账号 ' + users : '') +
                          (maps ? ' · 映射 ' + maps : '')
                      )
                    })
                  )
                : null,
              el(
                'div',
                { className: 'ctfcon-row', style: { marginBottom: 8 } },
                el('button', { className: 'ctfcon-btn primary', disabled: busy, onClick: startSolving }, '开始解题'),
                el('button', { className: 'ctfcon-btn', disabled: busy, onClick: function () { build(detail.id) } }, '启动环境'),
                el('button', { className: 'ctfcon-btn', disabled: busy, onClick: function () { recover(detail.id) } }, '回收环境'),
                el('button', { className: 'ctfcon-btn', disabled: busy, onClick: function () { openDetail(detail.id) } }, '刷新详情')
              ),
              el(
                'div',
                { className: 'ctfcon-row', style: { marginBottom: 8 } },
                el('input', {
                  className: 'ctfcon-input',
                  style: { flex: 1 },
                  value: flagInput,
                  placeholder: role === 'leader' ? '最终 flag（队长提交）' : '队长汇总区中的候选 flag',
                  onChange: function (e) {
                    setFlagInput(e.target.value)
                  },
                }),
                role === 'leader' ? el('button', { className: 'ctfcon-btn primary', disabled: busy, onClick: function () { submit(detail.id) } }, '队长提交最终 flag') : null
              ),
              elc('div', 'ctfcon-sec', '候选 flag 汇总'),
              el(
                'div',
                { className: 'ctfcon-row', style: { marginBottom: 6 } },
                el('input', {
                  className: 'ctfcon-input',
                  style: { flex: 1 },
                  value: candidateFlag,
                  placeholder: role === 'leader' ? '队长也可记录候选 flag' : '队员提交候选 flag 给队长',
                  onChange: function (e) { setCandidateFlag(e.target.value) },
                }),
                el('button', { className: 'ctfcon-btn', disabled: busy, onClick: submitCandidateFlag }, '汇总给队长')
              ),
              el('textarea', {
                className: 'ctfcon-input',
                style: { width: '100%', minHeight: 62, resize: 'vertical' },
                value: candidateNote,
                placeholder: '候选 flag 说明 / 证据 / 复现步骤（可选）',
                onChange: function (e) { setCandidateNote(e.target.value) },
              })
            )
          : null,
        elc(
          'div',
          'ctfcon-card',
          elc('div', 'ctfcon-sec', '日志'),
          log.length
            ? el(
                'div',
                { className: 'ctfcon-log' },
                log.map(function (l, i) {
                  const c =
                    l.kind === 'err'
                      ? 'var(--dsw-alias-state-error-primary)'
                      : l.kind === 'warn'
                        ? 'var(--dsw-alias-state-warn-primary)'
                        : 'var(--dsw-alias-state-success-primary)'
                  return el('div', { key: i, style: { color: c } }, '· ' + l.msg)
                })
              )
            : el('span', { className: 'ctfcon-muted' }, '暂无操作')
        )
      )
    )
  }

  ctx.effect(
    function () {
      const disposers = [
        slots.inject('sidebar.footer.action', function () {
          return slots.register(
            { name: 'sidebar.footer.action', id: 'ctf-console', order: 200, label: 'CTF 控制台' },
            function (props) {
              return el(FooterButton, props)
            }
          )
        }),
        slots.inject('conversation.session.header.actions', function () {
          return slots.register(
            { name: 'conversation.session.header.actions', id: 'ctf-console', order: 30, label: 'CTF 控制台' },
            function (props) {
              return el(HeaderButton, props)
            }
          )
        }),
      ]
      return function () {
        disposers.forEach(function (d) {
          if (d) d()
        })
        if (panelDisposer) {
          panelDisposer()
          panelDisposer = null
        }
      }
    },
    'ctf-console client slots'
  )
}


    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
