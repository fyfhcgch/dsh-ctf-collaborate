import { createApp, computed, onBeforeUnmount, onMounted, reactive } from 'vue'
import ElementPlus, { ElMessageBox } from 'element-plus'
import 'element-plus/dist/index.css'
import './styles.css'

type Category = 'web' | 'pwn' | 'crypto' | 'rev' | 'misc' | 'forensic'
type Status = 'pending' | 'solving' | 'solved'
type EvidenceType = 'tool_output' | 'file_extract' | 'log'
interface Challenge { challengeId: string; title: string; category: Category; description: string; attachmentPaths: string[]; status: Status; flag?: string; createdAt: number }
interface Note { id: string; challengeId: string; authorUserId: string; content: string; createdAt: number }
interface SharedNote { challengeId: string; content: string; updatedBy: string; updatedAt: number }
interface Thought { id: string; challengeId: string; source: string; content: string; createdAt: number }
interface Evidence { id: string; challengeId: string; type: EvidenceType; content: string; createdAt: number }
interface Task { taskId: string; challengeId: string; ownerUserId: string; prompt: string; done: boolean; result: string; createdAt: number }
interface Detail { challenge: Challenge; sharedNote: SharedNote | null; notes: Note[]; thoughts: Thought[]; evidence: Evidence[]; tasks: Task[] }

const base = (document.querySelector('meta[name="ctf-team-base"]')?.getAttribute('content') || location.pathname).replace(/\/$/, '')
const apiUrl = (path: string) => `${base}/api${path}`
const json = async (path: string, init?: RequestInit) => {
  const response = await fetch(apiUrl(path), { headers: { 'Content-Type': 'application/json' }, ...init })
  const data = await response.json() as { error?: string }
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}
const post = (path: string, body: unknown) => json(path, { method: 'POST', body: JSON.stringify(body) })
const savedMember = () => { try { return localStorage.getItem('dsh-ctf-team:member') || '' } catch { return '' } }
const formatTime = (value: number) => new Date(value).toLocaleString()
const categoryLabel: Record<Category, string> = { web: 'Web', pwn: 'Pwn', crypto: 'Crypto', rev: 'Reverse', misc: 'Misc', forensic: 'Forensic' }
const statusLabel: Record<Status, string> = { pending: '待解', solving: '正在解', solved: '已解出' }
const evidenceLabel: Record<EvidenceType, string> = { tool_output: '工具输出', file_extract: '文件提取', log: '命令日志' }

const app = createApp({
  setup() {
    const state = reactive({
      challenges: [] as Challenge[], detail: null as Detail | null, selectedId: '', tab: 'overview',
      loading: false, saving: false, error: '', notice: '', showCreate: false,
      create: { title: '', category: 'web' as Category, status: 'pending' as Status, description: '', attachments: '', flag: '' },
      edit: { title: '', category: 'web' as Category, status: 'pending' as Status, description: '', attachments: '', flag: '' },
      note: { authorUserId: '', content: '' }, evidence: { type: 'tool_output' as EvidenceType, content: '' },
      task: { ownerUserId: '', prompt: '' }, sharedNote: { content: '', updatedBy: '' }, sharedNoteDirty: false, sharedNoteChallengeId: '', memberName: savedMember(), eventSource: null as EventSource | null,
    })
    const counts = computed(() => state.challenges.reduce((result: Record<Status, number>, challenge: Challenge) => { result[challenge.status] += 1; return result }, { pending: 0, solving: 0, solved: 0 } as Record<Status, number>))
    const selected = computed(() => state.detail?.challenge ?? state.challenges.find((item: Challenge) => item.challengeId === state.selectedId) ?? null)
    const attachmentText = (paths: string[]) => paths.join('\n')
    const splitAttachments = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
    const copyChallengeToEdit = (challenge: Challenge) => Object.assign(state.edit, { title: challenge.title, category: challenge.category, status: challenge.status, description: challenge.description, attachments: attachmentText(challenge.attachmentPaths), flag: challenge.flag || '' })
    const notifyError = (error: unknown) => { state.error = error instanceof Error ? error.message : String(error); state.notice = '' }
    const notify = (message: string) => { state.notice = message; state.error = '' }
    const currentMember = () => state.memberName.trim() || 'web-user'
    const saveMember = () => { state.memberName = state.memberName.trim(); try { localStorage.setItem('dsh-ctf-team:member', state.memberName) } catch {} }
    const load = async (keepSelection = true) => {
      state.loading = true
      try {
        const list = await json('/challenges') as Challenge[]
        state.challenges = list
        if (!keepSelection || !state.selectedId || !list.some(item => item.challengeId === state.selectedId)) state.selectedId = list[0]?.challengeId || ''
        if (state.selectedId) {
          state.detail = await json(`/challenges/${encodeURIComponent(state.selectedId)}`) as Detail
          copyChallengeToEdit(state.detail.challenge)
          if (state.sharedNoteChallengeId !== state.selectedId || !state.sharedNoteDirty) {
            Object.assign(state.sharedNote, { content: state.detail.sharedNote?.content || '', updatedBy: state.detail.sharedNote?.updatedBy || '' })
            state.sharedNoteChallengeId = state.selectedId
            state.sharedNoteDirty = false
          }
        } else state.detail = null
        state.error = ''
      } catch (error) { notifyError(error) } finally { state.loading = false }
    }
    const selectChallenge = async (id: string) => { state.selectedId = id; state.tab = 'overview'; await load(true) }
    const createChallenge = async () => {
      state.saving = true
      try {
        const result = await post('/challenges', { title: state.create.title, category: state.create.category, status: state.create.status, description: state.create.description, attachmentPaths: splitAttachments(state.create.attachments), flag: state.create.flag || undefined }) as { challenge: Challenge }
        state.selectedId = result.challenge.challengeId; state.showCreate = false; Object.assign(state.create, { title: '', description: '', attachments: '', flag: '', category: 'web', status: 'pending' }); notify('题目已创建'); await load(true)
      } catch (error) { notifyError(error) } finally { state.saving = false }
    }
    const updateChallenge = async () => {
      if (!state.selectedId) return
      state.saving = true
      try { await post(`/challenges/${encodeURIComponent(state.selectedId)}/update`, { title: state.edit.title, category: state.edit.category, status: state.edit.status, description: state.edit.description, attachmentPaths: splitAttachments(state.edit.attachments), flag: state.edit.flag || undefined }); notify('题目详情已保存'); await load(true) }
      catch (error) { notifyError(error) } finally { state.saving = false }
    }
    const deleteChallenge = async () => {
      if (!state.selectedId) return
      try {
        await ElMessageBox.confirm('删除后该题目的笔记、证据和 Agent 记录也会一并删除。', '确认删除题目', { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' })
        await post(`/challenges/${encodeURIComponent(state.selectedId)}/delete`, {})
        state.selectedId = ''; state.detail = null; notify('题目已删除'); await load(false)
      } catch (error) { if (error !== 'cancel' && error !== 'close') notifyError(error) }
    }
    const saveSharedNote = async () => {
      if (!state.selectedId) return
      state.saving = true
      try {
        saveMember()
        await post('/shared-note', { challengeId: state.selectedId, updatedBy: currentMember(), content: state.sharedNote.content })
        state.sharedNoteDirty = false
        notify('共享笔记已保存，所有打开的页面会自动刷新')
        await load(true)
      } catch (error) { notifyError(error) } finally { state.saving = false }
    }
    const addEvidence = async () => {
      if (!state.selectedId) return
      try { await post('/evidence', { challengeId: state.selectedId, type: state.evidence.type, content: state.evidence.content }); state.evidence.content = ''; notify('证据已归档'); await load(true) }
      catch (error) { notifyError(error) }
    }
    const startTask = async () => {
      if (!state.selectedId) return
      try { await post('/agent/spawn', { challengeId: state.selectedId, ownerUserId: state.task.ownerUserId || undefined, prompt: state.task.prompt }); state.task.prompt = ''; notify('Agent 任务已提交，日志会实时显示在黑板'); await load(true) }
      catch (error) { notifyError(error) }
    }
    const switchTab = (tab: string) => { state.tab = tab }
    let timer: number | undefined
    onMounted(() => {
      state.eventSource = new EventSource(apiUrl('/events'))
      state.eventSource.onmessage = () => { void load(true) }
      state.eventSource.onerror = () => { /* EventSource will reconnect; polling below keeps the view fresh. */ }
      void load(false)
      timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(true) }, 15000)
    })
    onBeforeUnmount(() => { if (timer !== undefined) window.clearInterval(timer); state.eventSource?.close() })
    return { state, counts, selected, categoryLabel, statusLabel, evidenceLabel, formatTime, load, selectChallenge, createChallenge, updateChallenge, deleteChallenge, saveSharedNote, addEvidence, startTask, switchTab, saveMember }
  },
  template: `
  <el-container class="ctf-app">
    <el-header class="ctf-topbar">
      <div><h1>🏁 CTF Team</h1><p>同一 Harness 地址下，所有打开面板的队员共享同一份 SQLite 数据</p></div>
      <div class="top-actions"><el-input v-model="state.memberName" @change="saveMember" placeholder="你的队员名" style="width: 150px" /><el-button @click="load(true)" :loading="state.loading">刷新</el-button><el-tag type="success">SSE 实时同步</el-tag></div>
    </el-header>
    <el-alert v-if="state.error" :title="state.error" type="error" show-icon closable @close="state.error=''" />
    <el-alert v-if="state.notice" :title="state.notice" type="success" show-icon closable @close="state.notice=''" />
    <div class="ctf-stats"><el-card shadow="never"><b>{{ state.challenges.length }}</b><span>题目总数</span></el-card><el-card shadow="never"><b>{{ counts.pending }}</b><span>待解</span></el-card><el-card shadow="never"><b>{{ counts.solving }}</b><span>正在解</span></el-card><el-card shadow="never"><b>{{ counts.solved }}</b><span>已解出</span></el-card></div>
    <el-main class="ctf-layout">
      <el-card class="challenge-sidebar" shadow="never">
        <div class="side-heading"><h2>题目清单</h2><el-button type="primary" @click="state.showCreate = !state.showCreate">{{ state.showCreate ? '收起' : '添加题目' }}</el-button></div>
        <el-form v-if="state.showCreate" class="create-form" label-position="top" @submit.prevent="createChallenge">
          <el-form-item label="题目名称"><el-input v-model="state.create.title" maxlength="200" show-word-limit /></el-form-item>
          <div class="form-grid"><el-form-item label="分类"><el-select v-model="state.create.category"><el-option v-for="(label,key) in categoryLabel" :key="key" :label="label" :value="key" /></el-select></el-form-item><el-form-item label="状态"><el-select v-model="state.create.status"><el-option v-for="(label,key) in statusLabel" :key="key" :label="label" :value="key" /></el-select></el-form-item></div>
          <el-form-item label="描述"><el-input v-model="state.create.description" type="textarea" :rows="3" /></el-form-item><el-form-item label="附件路径（每行一个）"><el-input v-model="state.create.attachments" type="textarea" :rows="2" /></el-form-item><el-form-item label="Flag（可选）"><el-input v-model="state.create.flag" /></el-form-item><el-button type="primary" native-type="submit" :loading="state.saving">创建题目</el-button>
        </el-form>
        <div class="challenge-list"><el-empty v-if="!state.challenges.length" description="还没有题目" /><button v-for="item in state.challenges" :key="item.challengeId" class="challenge-row" :class="{ active: item.challengeId === state.selectedId }" @click="selectChallenge(item.challengeId)"><strong>{{ item.title }}</strong><span><el-tag size="small">{{ categoryLabel[item.category] }}</el-tag><el-tag size="small" :type="item.status === 'solved' ? 'success' : item.status === 'solving' ? 'warning' : 'info'">{{ statusLabel[item.status] }}</el-tag></span></button></div>
      </el-card>
      <el-card class="challenge-detail" shadow="never" v-if="selected">
        <div class="detail-heading"><div><h2>{{ selected.title }}</h2><code>{{ selected.challengeId }}</code></div><el-button type="danger" plain @click="deleteChallenge">删除题目</el-button></div>
        <el-tabs v-model="state.tab" @tab-change="switchTab">
          <el-tab-pane label="题目详情" name="overview"><el-form label-position="top" @submit.prevent="updateChallenge"><el-form-item label="题目名称"><el-input v-model="state.edit.title" /></el-form-item><div class="form-grid"><el-form-item label="分类"><el-select v-model="state.edit.category"><el-option v-for="(label,key) in categoryLabel" :key="key" :label="label" :value="key" /></el-select></el-form-item><el-form-item label="状态"><el-select v-model="state.edit.status"><el-option v-for="(label,key) in statusLabel" :key="key" :label="label" :value="key" /></el-select></el-form-item></div><el-form-item label="描述"><el-input v-model="state.edit.description" type="textarea" :rows="5" /></el-form-item><el-form-item label="附件路径"><el-input v-model="state.edit.attachments" type="textarea" :rows="3" /></el-form-item><el-form-item label="Flag"><el-input v-model="state.edit.flag" show-password /></el-form-item><el-button type="primary" native-type="submit" :loading="state.saving">保存修改</el-button></el-form></el-tab-pane>
          <el-tab-pane label="共享笔记" name="notes"><el-alert title="这是每道题唯一的一份共享正文：所有队员都能编辑和查看，保存后其他浏览器通过 SSE 自动刷新。" type="info" :closable="false" /><el-alert v-if="state.sharedNoteDirty" title="你正在编辑尚未保存的本地内容；其他队员的更新会在你保存或放弃编辑后显示。" type="warning" :closable="false" class="shared-note-warning" /><el-form label-position="top" @submit.prevent="saveSharedNote" class="shared-note-form"><el-form-item label="解题思路 / 踩坑记录 / 备忘"><el-input v-model="state.sharedNote.content" @input="state.sharedNoteDirty = true" type="textarea" :rows="18" placeholder="全队共同维护这份笔记……" /></el-form-item><div class="shared-note-meta"><span v-if="state.detail?.sharedNote">最后编辑：{{ state.detail.sharedNote.updatedBy }} · {{ formatTime(state.detail.sharedNote.updatedAt) }}</span><span v-else>尚未保存</span><el-button type="primary" native-type="submit" :loading="state.saving">保存共享笔记</el-button></div></el-form></el-tab-pane>
          <el-tab-pane label="证据库" name="evidence"><div v-for="item in state.detail?.evidence" :key="item.id" class="record-card"><div><el-tag>{{ evidenceLabel[item.type] }}</el-tag><small>{{ formatTime(item.createdAt) }}</small></div><pre>{{ item.content }}</pre></div><el-empty v-if="!state.detail?.evidence.length" description="暂无证据" /><el-form label-position="top" @submit.prevent="addEvidence"><el-form-item label="类型"><el-select v-model="state.evidence.type"><el-option v-for="(label,key) in evidenceLabel" :key="key" :label="label" :value="key" /></el-select></el-form-item><el-form-item label="工具输出 / 文件提取结果 / 命令日志"><el-input v-model="state.evidence.content" type="textarea" :rows="6" /></el-form-item><el-button type="primary" native-type="submit">归档证据</el-button></el-form></el-tab-pane>
          <el-tab-pane label="Agent 日志" name="thoughts"><div v-for="item in state.detail?.thoughts" :key="item.id" class="record-card"><div><el-tag type="warning">{{ item.source }}</el-tag><small>{{ formatTime(item.createdAt) }}</small></div><p class="content">{{ item.content }}</p></div><el-empty v-if="!state.detail?.thoughts.length" description="Agent 运行日志会显示在这里" /></el-tab-pane>
          <el-tab-pane label="Agent 任务" name="tasks"><div v-for="item in state.detail?.tasks" :key="item.taskId" class="record-card"><div><el-tag :type="item.done ? 'success' : 'warning'">{{ item.done ? '已完成' : '运行中' }}</el-tag><small>{{ item.ownerUserId }} · {{ formatTime(item.createdAt) }}</small></div><p><b>Prompt：</b>{{ item.prompt }}</p><pre v-if="item.result">{{ item.result }}</pre></div><el-empty v-if="!state.detail?.tasks.length" description="暂无 Agent 任务" /><el-form label-position="top" @submit.prevent="startTask"><el-form-item label="Owner"><el-input v-model="state.task.ownerUserId" placeholder="默认使用当前队员标识" /></el-form-item><el-form-item label="任务 Prompt"><el-input v-model="state.task.prompt" type="textarea" :rows="6" placeholder="例如：审计该题附件中的源码，给出漏洞链和验证步骤" /></el-form-item><el-button type="primary" native-type="submit">启动 Agent 任务</el-button></el-form></el-tab-pane>
        </el-tabs>
      </el-card>
      <el-card v-else class="challenge-detail" shadow="never"><el-empty description="从左侧添加或选择一道题目" /></el-card>
    </el-main>
  </el-container>`,
})

app.use(ElementPlus)
app.mount('#app')
