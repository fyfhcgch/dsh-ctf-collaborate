import type { TeamP2PController, TeamP2PStatus } from './p2p.js'

export type ChallengeCategory = 'pwn' | 'crypto' | 'web' | 'rev' | 'misc' | 'forensic'
export type ChallengeStatus = 'pending' | 'solving' | 'solved'
export interface Challenge {
  challengeId: string
  title: string
  category: ChallengeCategory
  description: string
  attachmentPaths: string[]
  status: ChallengeStatus
  flag?: string
  createdAt: number
}
export interface TeamNote { id: string; challengeId: string; authorUserId: string; content: string; createdAt: number }
export interface AgentThought { id: string; challengeId: string; source: string; content: string; createdAt: number }
export interface EvidenceItem { id: string; challengeId: string; type: 'tool_output' | 'file_extract' | 'log'; content: string; createdAt: number }
export interface SubTask { taskId: string; challengeId: string; ownerUserId: string; prompt: string; done: boolean; result: string; createdAt: number }
export interface ChallengeDetail { challenge: Challenge; notes: TeamNote[]; thoughts: AgentThought[]; evidence: EvidenceItem[]; tasks: SubTask[] }
export interface TeamIdentity { teamId: string; peerId: string; createdAt: number }
export interface SyncStatus { teamId: string; peerId: string; operationCursor: number; operationCount: number }

export interface TeamBoardRemote {
  list(): Promise<Challenge[]>
  detail(challengeId: string): Promise<ChallengeDetail>
  create(input: Partial<Challenge>): Promise<Challenge>
  update(challengeId: string, input: Partial<Challenge>): Promise<Challenge>
  delete(challengeId: string): Promise<{ challengeId: string; deleted: true }>
  addNote(input: { challengeId: string; authorUserId?: string; content: string }): Promise<TeamNote>
  addEvidence(input: { challengeId: string; type?: EvidenceItem['type']; content: string }): Promise<EvidenceItem>
  addThought(input: { challengeId: string; source?: string; content: string }): Promise<AgentThought>
  spawnAgent(input: { challengeId: string; ownerUserId?: string; prompt: string }): Promise<{ taskId: string; response: string }>
  identity(): Promise<TeamIdentity>
  syncStatus(): Promise<SyncStatus>
}

type Tab = 'overview' | 'notes' | 'evidence' | 'thoughts' | 'tasks' | 'p2p'

interface BoardState {
  open: boolean
  tab: Tab
  challenges: Challenge[]
  selectedId?: string
  detail?: ChallengeDetail
  identity?: TeamIdentity
  sync?: SyncStatus
  p2p?: TeamP2PStatus
  loading: boolean
  message?: string
  error?: string
  inviteOffer?: string
  inviteAnswer?: string
  createOpen: boolean
}

const categories: ChallengeCategory[] = ['web', 'pwn', 'crypto', 'rev', 'forensic', 'misc']
const statuses: ChallengeStatus[] = ['pending', 'solving', 'solved']
const evidenceTypes: EvidenceItem['type'][] = ['tool_output', 'file_extract', 'log']

/** Vanilla browser UI for the Host-owned CTF team board. */
export class TeamBoard {
  private root?: HTMLElement
  private refreshTimer?: number
  private unsubscribeP2P?: () => void
  private sidebarIntegrated = false
  private sidebarWide = false
  private readonly drafts = new Map<string, string>()
  private readonly state: BoardState = {
    open: false,
    tab: 'overview',
    challenges: [],
    loading: false,
    createOpen: false,
  }

  constructor(
    private readonly remote: TeamBoardRemote,
    private readonly p2p: TeamP2PController,
    private readonly log: (message: string) => void = () => {},
  ) {}

  mount(): void {
    if (this.root) return
    const root = document.createElement('section')
    root.id = 'dsh-ctf-team-board'
    root.setAttribute('data-dsh-ctf-board', 'ready')
    root.setAttribute('data-sidebar-wide', this.sidebarWide ? '1' : '0')
    root.innerHTML = `<style>${styles}</style><div class="dsh-ctf-shell"></div>`
    document.body.appendChild(root)
    this.root = root
    root.addEventListener('click', (event) => { void this.onClick(event) })
    root.addEventListener('submit', (event) => { void this.onSubmit(event) })
    root.addEventListener('change', (event) => { void this.onChange(event) })
    root.addEventListener('input', (event) => { this.onInput(event) })
    window.addEventListener('dsh-ctf-team:sync', this.onExternalSync)
    this.unsubscribeP2P = this.p2p.subscribe((status) => {
      this.state.p2p = status
      this.render()
    })
    this.refreshTimer = window.setInterval(() => { void this.refresh({ quiet: true }) }, 5000)
    void this.refresh()
  }

  setSidebarIntegrated(value: boolean): void {
    this.sidebarIntegrated = value
    this.render()
  }

  setSidebarWide(value: boolean): void {
    this.sidebarWide = value
    this.render()
  }

  toggleOpen(): void {
    this.state.open = !this.state.open
    this.render()
    if (this.state.open) void this.refresh({ quiet: true })
  }

  openPanel(): void {
    this.state.open = true
    this.render()
    void this.refresh({ quiet: true })
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) window.clearInterval(this.refreshTimer)
    this.unsubscribeP2P?.()
    window.removeEventListener('dsh-ctf-team:sync', this.onExternalSync)
    this.root?.remove()
    this.root = undefined
  }

  async refresh(options: { quiet?: boolean } = {}): Promise<void> {
    if (!this.root) return
    if (!options.quiet) this.state.loading = true
    this.state.error = undefined
    try {
      const [identity, sync, challenges] = await Promise.all([
        this.remote.identity(),
        this.remote.syncStatus(),
        this.remote.list(),
      ])
      this.state.identity = identity
      this.state.sync = sync
      this.state.challenges = challenges
      if (!this.state.selectedId && challenges[0]) this.state.selectedId = challenges[0].challengeId
      if (this.state.selectedId && !challenges.some((challenge) => challenge.challengeId === this.state.selectedId)) {
        this.state.selectedId = challenges[0]?.challengeId
        this.state.detail = undefined
      }
      await this.loadDetail()
    } catch (cause) {
      this.state.error = errorMessage(cause)
    } finally {
      this.state.loading = false
      this.render()
    }
  }

  private readonly onExternalSync = () => { void this.refresh({ quiet: true }) }

  private async loadDetail(): Promise<void> {
    if (!this.state.selectedId) {
      this.state.detail = undefined
      return
    }
    this.state.detail = await this.remote.detail(this.state.selectedId)
  }

  private async run(message: string, operation: () => Promise<unknown>): Promise<void> {
    this.state.loading = true
    this.state.error = undefined
    this.state.message = undefined
    this.render()
    try {
      await operation()
      this.state.message = message
      await this.refresh({ quiet: true })
    } catch (cause) {
      this.state.error = errorMessage(cause)
      this.log(this.state.error)
    } finally {
      this.state.loading = false
      this.render()
    }
  }

  private async onClick(event: Event): Promise<void> {
    const target = (event.target as Element | null)?.closest<HTMLElement>('[data-action]')
    if (!target) return
    const action = target.dataset.action
    if (action === 'toggle') {
      this.toggleOpen()
      return
    }
    if (action === 'toggle-create') {
      this.state.createOpen = !this.state.createOpen
      this.render()
      return
    }
    if (action === 'refresh') { await this.refresh(); return }
    if (action === 'select') {
      const id = target.dataset.id
      if (id) {
        this.state.selectedId = id
        this.state.tab = 'overview'
        await this.refresh({ quiet: true })
      }
      return
    }
    if (action === 'tab') {
      const tab = target.dataset.tab as Tab | undefined
      if (tab) {
        this.state.tab = tab
        this.render()
      }
      return
    }
    if (action === 'delete' && this.state.selectedId) {
      const id = this.state.selectedId
      await this.run('挑战已删除', async () => {
        await this.remote.delete(id)
        this.state.selectedId = undefined
        this.state.detail = undefined
      })
      return
    }
    if (action === 'copy') {
      const source = target.dataset.source
      const value = source === 'offer' ? this.state.inviteOffer : this.state.inviteAnswer
      if (value) {
        await navigator.clipboard?.writeText(value)
        this.state.message = '邀请文本已复制'
        this.render()
      }
      return
    }
    if (action === 'clear-invites') {
      this.state.inviteOffer = undefined
      this.state.inviteAnswer = undefined
      this.state.message = '邀请文本已清空'
      this.render()
      return
    }
    if (action === 'disconnect') {
      this.p2p.disconnect(target.dataset.peer)
      this.state.message = 'P2P 连接已断开'
      this.render()
    }
  }

  private onInput(event: Event): void {
    const field = event.target as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
    if (!field?.name) return
    const form = field.closest<HTMLFormElement>('form[data-action]')
    const action = form?.dataset.action
    if (!action) return
    this.drafts.set(this.draftKey(action, field.name), field.value)
  }

  private async onChange(event: Event): Promise<void> {
    const target = (event.target as Element | null)?.closest<HTMLSelectElement>('[data-action="quick-status"]')
    if (!target || !target.dataset.id) return
    const id = target.dataset.id
    const status = target.value as ChallengeStatus
    await this.run('状态已更新', async () => {
      await this.remote.update(id, { status })
      this.state.selectedId = id
    })
  }

  private async onSubmit(event: Event): Promise<void> {
    const form = event.target as HTMLFormElement
    if (!form?.dataset?.action) return
    event.preventDefault()
    const action = form.dataset.action
    const data = new FormData(form)
    if (action === 'create') {
      await this.run('挑战已创建', async () => {
        const created = await this.remote.create({
          challengeId: text(data, 'challengeId') || undefined,
          title: text(data, 'title'),
          category: (text(data, 'category') || 'misc') as ChallengeCategory,
          description: text(data, 'description'),
          status: (text(data, 'status') || 'pending') as ChallengeStatus,
          flag: text(data, 'flag') || undefined,
          attachmentPaths: splitLines(text(data, 'attachmentPaths')),
        })
        this.state.selectedId = created.challengeId
        this.state.tab = 'overview'
        this.state.createOpen = false
        this.clearDraft('create')
        form.reset()
      })
      return
    }
    if (!this.state.selectedId) return
    const challengeId = this.state.selectedId
    if (action === 'update') {
      await this.run('挑战详情已保存', async () => {
        await this.remote.update(challengeId, {
          title: text(data, 'title'),
          category: text(data, 'category') as ChallengeCategory,
          description: text(data, 'description'),
          status: text(data, 'status') as ChallengeStatus,
          flag: text(data, 'flag') || undefined,
          attachmentPaths: splitLines(text(data, 'attachmentPaths')),
        })
      })
      return
    }
    if (action === 'note') {
      await this.run('笔记已添加', async () => {
        await this.remote.addNote({ challengeId, authorUserId: text(data, 'authorUserId') || undefined, content: text(data, 'content') })
        this.clearDraft('note')
        form.reset()
      })
      return
    }
    if (action === 'evidence') {
      await this.run('证据已添加', async () => {
        await this.remote.addEvidence({ challengeId, type: (text(data, 'type') || 'log') as EvidenceItem['type'], content: text(data, 'content') })
        this.clearDraft('evidence')
        form.reset()
      })
      return
    }
    if (action === 'thought') {
      await this.run('思考已添加', async () => {
        await this.remote.addThought({ challengeId, source: text(data, 'source') || undefined, content: text(data, 'content') })
        this.clearDraft('thought')
        form.reset()
      })
      return
    }
    if (action === 'task') {
      await this.run('任务已提交', async () => {
        await this.remote.spawnAgent({ challengeId, ownerUserId: text(data, 'ownerUserId') || undefined, prompt: text(data, 'prompt') })
        this.clearDraft('task')
        form.reset()
      })
      return
    }
    if (action === 'create-offer') {
      await this.run('P2P Offer 已生成', async () => { this.state.inviteOffer = await this.p2p.createInvite() })
      return
    }
    if (action === 'accept-offer') {
      await this.run('P2P Answer 已生成', async () => { this.state.inviteAnswer = await this.p2p.acceptInvite(text(data, 'invite')) })
      return
    }
    if (action === 'complete-answer') {
      await this.run('P2P 邀请已完成', async () => { await this.p2p.completeInvite(text(data, 'invite')); this.clearDraft('complete-answer'); form.reset() })
    }
  }

  private render(): void {
    const shell = this.root?.querySelector<HTMLElement>('.dsh-ctf-shell')
    if (!shell) return
    if (this.root) this.root.setAttribute('data-sidebar-wide', this.sidebarWide ? '1' : '0')
    shell.innerHTML = this.state.open ? this.renderPanel() : this.renderLauncher()
  }

  private renderLauncher(): string {
    if (this.sidebarIntegrated) return ''
    const count = this.state.challenges.length
    return `<button class="ctf-launcher" type="button" data-action="toggle">🏁 CTF Board <span>${count}</span></button>`
  }

  private renderPanel(): string {
    return `
      <div class="ctf-panel" role="region" aria-label="CTF Board">
        <header class="ctf-header">
          <div>
            <strong>🏁 CTF Board</strong>
            <small>${escapeHtml(this.state.identity?.teamId ?? 'loading')} · ${shortId(this.state.identity?.peerId)}</small>
          </div>
          <div class="ctf-header-actions">
            ${this.state.loading ? '<span class="ctf-spinner">sync</span>' : ''}
            <button type="button" data-action="refresh">刷新</button>
            <button type="button" data-action="toggle">收起</button>
          </div>
        </header>
        ${this.renderAlerts()}
        <div class="ctf-stats">
          <span>挑战 <b>${this.state.challenges.length}</b></span>
          <span>Ops <b>${this.state.sync?.operationCount ?? 0}</b></span>
          <span>Peers <b>${this.state.p2p?.peers.length ?? 0}</b></span>
          <span class="${this.state.p2p?.enabled ? 'ok' : 'warn'}">${this.state.p2p?.enabled ? 'WebRTC ready' : 'WebRTC off'}</span>
        </div>
        <main class="ctf-main">
          <aside class="ctf-list">
            ${this.renderCreateForm()}
            <div class="ctf-list-scroll">${this.renderChallengeList()}</div>
          </aside>
          <section class="ctf-detail">
            ${this.state.detail ? this.renderDetail(this.state.detail) : '<div class="ctf-empty">暂无挑战，先创建一个。</div>'}
          </section>
        </main>
      </div>`
  }

  private renderAlerts(): string {
    return `${this.state.error ? `<div class="ctf-alert error">${escapeHtml(this.state.error)}</div>` : ''}${this.state.message ? `<div class="ctf-alert ok">${escapeHtml(this.state.message)}</div>` : ''}`
  }

  private renderCreateForm(): string {
    if (!this.state.createOpen) {
      return `<div class="ctf-create"><button type="button" data-action="toggle-create">+ 新建挑战</button></div>`
    }
    return `<div class="ctf-create open">
      <button class="ctf-create-toggle" type="button" data-action="toggle-create">− 收起新建</button>
      <form data-action="create">
        <input name="title" required maxlength="200" placeholder="标题" value="${this.draft('create', 'title')}">
        <div class="grid2">${select('category', categories, this.draft('create', 'category', 'misc') as ChallengeCategory)}${select('status', statuses, this.draft('create', 'status', 'pending') as ChallengeStatus)}</div>
        <input name="challengeId" maxlength="128" placeholder="自定义 ID（可选）" value="${this.draft('create', 'challengeId')}">
        <textarea name="description" rows="2" placeholder="描述">${this.draft('create', 'description')}</textarea>
        <textarea name="attachmentPaths" rows="2" placeholder="附件路径，每行一个">${this.draft('create', 'attachmentPaths')}</textarea>
        <input name="flag" placeholder="flag（可选）" value="${this.draft('create', 'flag')}">
        <button type="submit">创建</button>
      </form>
    </div>`
  }

  private renderChallengeList(): string {
    if (!this.state.challenges.length) return '<div class="ctf-empty small">暂无挑战</div>'
    return this.state.challenges.map((challenge) => `
      <article class="ctf-card ${challenge.challengeId === this.state.selectedId ? 'selected' : ''}" data-action="select" data-id="${escapeAttr(challenge.challengeId)}">
        <div class="ctf-card-title">${escapeHtml(challenge.title)}</div>
        <div class="ctf-card-meta"><span>${escapeHtml(challenge.category)}</span><span>${escapeHtml(challenge.status)}</span><span>${time(challenge.createdAt)}</span></div>
        <select data-action="quick-status" data-id="${escapeAttr(challenge.challengeId)}" onclick="event.stopPropagation()">${statuses.map((status) => `<option value="${status}" ${status === challenge.status ? 'selected' : ''}>${status}</option>`).join('')}</select>
      </article>`).join('')
  }

  private renderDetail(detail: ChallengeDetail): string {
    const tab = this.state.tab
    const challenge = detail.challenge
    return `
      <div class="ctf-detail-head">
        <div>
          <h2>${escapeHtml(challenge.title)}</h2>
          <code>${escapeHtml(challenge.challengeId)}</code>
        </div>
        <button class="danger" type="button" data-action="delete">删除</button>
      </div>
      <nav class="ctf-tabs">
        ${(['overview', 'notes', 'evidence', 'thoughts', 'tasks', 'p2p'] as Tab[]).map((item) => `<button type="button" data-action="tab" data-tab="${item}" class="${tab === item ? 'active' : ''}">${tabLabel(item)}</button>`).join('')}
      </nav>
      ${tab === 'overview' ? this.renderOverview(challenge) : ''}
      ${tab === 'notes' ? this.renderNotes(detail) : ''}
      ${tab === 'evidence' ? this.renderEvidence(detail) : ''}
      ${tab === 'thoughts' ? this.renderThoughts(detail) : ''}
      ${tab === 'tasks' ? this.renderTasks(detail) : ''}
      ${tab === 'p2p' ? this.renderP2P() : ''}`
  }

  private renderOverview(challenge: Challenge): string {
    return `<form class="ctf-form" data-action="update">
      <label>标题<input name="title" required maxlength="200" value="${this.draft('update', 'title', challenge.title)}"></label>
      <div class="grid2"><label>分类${select('category', categories, this.draft('update', 'category', challenge.category) as ChallengeCategory)}</label><label>状态${select('status', statuses, this.draft('update', 'status', challenge.status) as ChallengeStatus)}</label></div>
      <label>描述<textarea name="description" rows="5">${this.draft('update', 'description', challenge.description)}</textarea></label>
      <label>附件路径<textarea name="attachmentPaths" rows="3">${this.draft('update', 'attachmentPaths', challenge.attachmentPaths.join('\n'))}</textarea></label>
      <label>Flag<input name="flag" value="${this.draft('update', 'flag', challenge.flag ?? '')}" placeholder="flag{...}"></label>
      <button type="submit">保存详情</button>
    </form>`
  }

  private renderNotes(detail: ChallengeDetail): string {
    return `${timeline(detail.notes, (item) => `<b>${escapeHtml(item.authorUserId)}</b><small>${time(item.createdAt)}</small><p>${escapeHtml(item.content)}</p>`)}
      <form class="ctf-form inline" data-action="note"><input name="authorUserId" placeholder="作者" value="${this.draft('note', 'authorUserId')}"><textarea name="content" required rows="3" placeholder="笔记内容">${this.draft('note', 'content')}</textarea><button>添加笔记</button></form>`
  }

  private renderEvidence(detail: ChallengeDetail): string {
    return `${timeline(detail.evidence, (item) => `<b>${escapeHtml(item.type)}</b><small>${time(item.createdAt)}</small><pre>${escapeHtml(item.content)}</pre>`)}
      <form class="ctf-form inline" data-action="evidence"><select name="type">${evidenceTypes.map((type) => `<option value="${type}" ${type === this.draft('evidence', 'type', 'tool_output') ? 'selected' : ''}>${type}</option>`).join('')}</select><textarea name="content" required rows="4" placeholder="工具输出、文件摘录或日志">${this.draft('evidence', 'content')}</textarea><button>添加证据</button></form>`
  }

  private renderThoughts(detail: ChallengeDetail): string {
    return `${timeline(detail.thoughts, (item) => `<b>${escapeHtml(item.source)}</b><small>${time(item.createdAt)}</small><p>${escapeHtml(item.content)}</p>`)}
      <form class="ctf-form inline" data-action="thought"><input name="source" placeholder="来源" value="${this.draft('thought', 'source')}"><textarea name="content" required rows="3" placeholder="思考流记录">${this.draft('thought', 'content')}</textarea><button>添加思考</button></form>`
  }

  private renderTasks(detail: ChallengeDetail): string {
    const tasks = detail.tasks.length ? detail.tasks.map((task) => `<article class="ctf-item"><b>${escapeHtml(task.ownerUserId)}</b><small>${time(task.createdAt)} · ${task.done ? 'done' : 'running'}</small><p>${escapeHtml(task.prompt)}</p>${task.result ? `<pre>${escapeHtml(task.result)}</pre>` : ''}</article>`).join('') : '<div class="ctf-empty small">暂无任务</div>'
    return `${tasks}<form class="ctf-form inline" data-action="task"><input name="ownerUserId" placeholder="Owner" value="${this.draft('task', 'ownerUserId')}"><textarea name="prompt" required rows="4" placeholder="给 agent 的任务提示">${this.draft('task', 'prompt')}</textarea><button>启动任务</button></form>`
  }

  private draft(action: string, name: string, fallback = ''): string {
    return escapeAttr(this.drafts.get(this.draftKey(action, name)) ?? fallback)
  }

  private draftKey(action: string, name: string): string {
    const scoped = action === 'update' ? (this.state.selectedId ?? '') : ''
    return `${action}:${scoped}:${name}`
  }

  private clearDraft(action: string): void {
    const prefix = `${action}:`
    for (const key of [...this.drafts.keys()]) {
      if (key.startsWith(prefix)) this.drafts.delete(key)
    }
  }

  private renderP2P(): string {
    const p2p = this.state.p2p
    return `<div class="ctf-p2p">
      <div class="ctf-p2p-status">
        <b>${p2p?.enabled ? 'P2P 已启用' : 'P2P 未启用'}</b>
        <span>Team ${escapeHtml(p2p?.teamId ?? this.state.identity?.teamId ?? '-')}</span>
        <span>Peer ${escapeHtml(shortId(p2p?.peerId ?? this.state.identity?.peerId))}</span>
      </div>
      <div class="ctf-peers">
        ${(p2p?.peers.length ? p2p.peers.map((peer) => `<article class="ctf-item"><b>${escapeHtml(peer.peerId)}</b><small>${escapeHtml(peer.state)}${peer.lastSeenAt ? ` · seen ${time(peer.lastSeenAt)}` : ''}</small><button type="button" data-action="disconnect" data-peer="${escapeAttr(peer.peerId)}">断开</button></article>`).join('') : '<div class="ctf-empty small">暂无已连接 Peer</div>')}
      </div>
      <div class="grid2 p2p-forms">
        <form class="ctf-form" data-action="create-offer"><button>生成 Offer</button>${this.state.inviteOffer ? `<textarea readonly rows="5">${escapeHtml(this.state.inviteOffer)}</textarea><button type="button" data-action="copy" data-source="offer">复制 Offer</button>` : ''}</form>
        <form class="ctf-form" data-action="accept-offer"><textarea name="invite" required rows="5" placeholder="粘贴对方 Offer">${this.draft('accept-offer', 'invite')}</textarea><button>生成 Answer</button>${this.state.inviteAnswer ? `<textarea readonly rows="5">${escapeHtml(this.state.inviteAnswer)}</textarea><button type="button" data-action="copy" data-source="answer">复制 Answer</button>` : ''}</form>
      </div>
      <form class="ctf-form" data-action="complete-answer"><textarea name="invite" required rows="4" placeholder="Offer 发起方粘贴对方 Answer">${this.draft('complete-answer', 'invite')}</textarea><button>完成连接</button><button type="button" data-action="clear-invites">清空邀请文本</button></form>
    </div>`
  }
}

function timeline<T>(items: T[], render: (item: T) => string): string {
  return items.length ? items.map((item) => `<article class="ctf-item">${render(item)}</article>`).join('') : '<div class="ctf-empty small">暂无记录</div>'
}
function select<T extends string>(name: string, values: T[], selected: T): string {
  return `<select name="${escapeAttr(name)}">${values.map((value) => `<option value="${escapeAttr(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('')}</select>`
}
function text(data: FormData, key: string): string { return String(data.get(key) ?? '').trim() }
function splitLines(value: string): string[] { return value.split(/\r?\n/u).map((item) => item.trim()).filter(Boolean) }
function shortId(value: string | undefined): string { return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : '-' }
function time(value: number): string { return new Date(value).toLocaleString() }
function tabLabel(tab: Tab): string {
  return ({ overview: '详情', notes: '笔记', evidence: '证据', thoughts: '思考流', tasks: '任务', p2p: 'P2P' })[tab]
}
function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause) }
function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char)
}
function escapeAttr(value: unknown): string { return escapeHtml(value) }

const styles = `
#dsh-ctf-team-board{position:fixed;left:var(--dsh-ctf-board-left,72px);top:14px;right:14px;bottom:14px;z-index:2147483000;font:13px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;pointer-events:none}#dsh-ctf-team-board[data-sidebar-wide="1"]{--dsh-ctf-board-left:316px}#dsh-ctf-team-board[data-sidebar-wide="0"]{--dsh-ctf-board-left:72px}#dsh-ctf-team-board:empty{display:none}.ctf-launcher{pointer-events:auto;border:1px solid #111;background:#fff;color:#111;border-radius:12px;padding:9px 12px;box-shadow:0 8px 24px #0002;cursor:pointer}.ctf-launcher span{margin-left:8px;border:1px solid #111;border-radius:999px;padding:1px 6px}.ctf-panel{pointer-events:auto;width:min(980px,100%);height:100%;background:#fff;border:1px solid #111;border-radius:14px;box-shadow:0 18px 60px #0003;overflow:hidden;display:flex;flex-direction:column}.ctf-header{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:12px 14px;background:#fff;border-bottom:1px solid #111}.ctf-header strong{font-size:16px}.ctf-header small{display:block;color:#555}.ctf-header-actions{display:flex;gap:8px;align-items:center}.ctf-panel button,.ctf-panel input,.ctf-panel select,.ctf-panel textarea{font:inherit}.ctf-panel button{border:1px solid #111;background:#111;color:#fff;border-radius:9px;padding:7px 10px;cursor:pointer}.ctf-panel button:hover{background:#333}.ctf-panel button.danger{background:#fff;color:#111;border-color:#111}.ctf-panel button.danger:hover{background:#f2f2f2}.ctf-panel input,.ctf-panel select,.ctf-panel textarea{width:100%;box-sizing:border-box;border:1px solid #bbb;background:#fff;color:#111;border-radius:9px;padding:8px;outline:none}.ctf-panel input:focus,.ctf-panel select:focus,.ctf-panel textarea:focus{border-color:#111;box-shadow:0 0 0 2px #0001}.ctf-panel textarea{resize:vertical}.ctf-stats{display:flex;gap:8px;flex-wrap:wrap;padding:9px 14px;border-bottom:1px solid #e5e5e5}.ctf-stats span,.ctf-card-meta span{background:#fff;border:1px solid #ddd;border-radius:999px;padding:3px 8px;color:#222}.ctf-stats .ok{border-color:#111;color:#111}.ctf-stats .warn{border-color:#777;color:#555}.ctf-main{display:grid;grid-template-columns:300px 1fr;min-height:0;flex:1}.ctf-list{border-right:1px solid #e5e5e5;min-height:0;display:flex;flex-direction:column;background:#fafafa}.ctf-list-scroll,.ctf-detail{overflow:auto;padding:12px}.ctf-create{padding:12px;border-bottom:1px solid #e5e5e5}.ctf-create>button{width:100%;background:#fff;color:#111}.ctf-create.open>button{margin-bottom:10px}.ctf-create form,.ctf-form{display:grid;gap:9px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:8px}.ctf-card{border:1px solid #ddd;background:#fff;border-radius:12px;padding:10px;margin-bottom:9px;cursor:pointer}.ctf-card:hover{border-color:#999}.ctf-card.selected{border-color:#111;box-shadow:0 0 0 1px #111 inset}.ctf-card-title{font-weight:700;margin-bottom:6px;color:#111}.ctf-card-meta{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:8px}.ctf-detail-head{display:flex;justify-content:space-between;gap:12px;align-items:start;margin-bottom:10px}.ctf-detail-head h2{margin:0 0 4px;color:#111}.ctf-detail-head code{color:#555}.ctf-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}.ctf-tabs button{background:#fff;color:#111;border-color:#bbb}.ctf-tabs button.active{background:#111;color:#fff;border-color:#111}.ctf-form label{display:grid;gap:5px;color:#333}.ctf-form.inline{border-top:1px solid #e5e5e5;margin-top:12px;padding-top:12px}.ctf-item{border:1px solid #ddd;background:#fff;border-radius:12px;padding:10px;margin-bottom:9px}.ctf-item b{color:#111}.ctf-item small{display:block;color:#666;margin:2px 0 6px}.ctf-item p{white-space:pre-wrap;margin:0;color:#111}.ctf-item pre{white-space:pre-wrap;overflow:auto;background:#f7f7f7;border:1px solid #ddd;border-radius:9px;padding:8px;color:#111}.ctf-empty{display:grid;place-items:center;min-height:160px;color:#777;border:1px dashed #bbb;border-radius:12px}.ctf-empty.small{min-height:auto;padding:16px}.ctf-alert{margin:10px 14px 0;padding:8px 10px;border-radius:10px;border:1px solid}.ctf-alert.error{background:#fff;border-color:#111;color:#111}.ctf-alert.ok{background:#f7f7f7;border-color:#999;color:#111}.ctf-spinner{color:#555}.ctf-p2p-status{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}.ctf-p2p-status span{background:#fff;border:1px solid #ddd;border-radius:999px;padding:3px 8px}.p2p-forms textarea[readonly]{margin-top:8px}.dsh-ctf-team-sidebar-action{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid #111;background:#fff;color:#111;border-radius:10px;padding:6px 10px;cursor:pointer;font:inherit;min-width:44px}.dsh-ctf-team-sidebar-action:hover{background:#f4f4f4}@media (max-width:860px){#dsh-ctf-team-board{left:10px;right:10px;top:10px;bottom:10px}.ctf-main{grid-template-columns:1fr}.ctf-list{max-height:42%;border-right:0;border-bottom:1px solid #e5e5e5}.ctf-panel{height:100%;width:100%}.grid2{grid-template-columns:1fr}}
`
