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
interface Task { taskId: string; challengeId: string; ownerUserId: string; expertType: 'general' | 'pwn' | 'reverse'; prompt: string; done: boolean; result: string; createdAt: number }
interface Detail { challenge: Challenge; sharedNote: SharedNote | null; notes: Note[]; thoughts: Thought[]; evidence: Evidence[]; tasks: Task[] }
interface PlatformStatus { enabled: boolean; competitionId?: string; stageId?: string; platformHost?: string; accessKeyConfigured?: boolean; gatewayEndpointConfigured?: boolean; gatewayEndpointAllowed?: boolean; event?: { startAt: string; endAt: string; active: boolean }; policy?: { maxSubmissionsPerExercise: number; requiresHumanConfirmation: boolean; automaticRetries: boolean } }
interface ExerciseInfo { id?: number; name?: string; isNeedInit: boolean; isNeedCheck: boolean; canRefreshEndpoint: boolean; endpointType?: string; endpoints: unknown[]; attachment: unknown[] }

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

const parseExerciseInfo = (challenge?: Challenge | null): ExerciseInfo | null => {
  if (!challenge?.description) return null
  try {
    const exercise = (JSON.parse(challenge.description) as { exercise?: Record<string, unknown> }).exercise
    if (!exercise || typeof exercise !== 'object') return null
    return {
      id: Number.isInteger(exercise.id) ? exercise.id as number : undefined,
      name: typeof exercise.name === 'string' ? exercise.name : undefined,
      isNeedInit: Boolean(exercise.isNeedInit),
      isNeedCheck: Boolean(exercise.isNeedCheck),
      canRefreshEndpoint: Boolean(exercise.canRefreshEndpoint),
      endpointType: typeof exercise.endpointType === 'string' ? exercise.endpointType : undefined,
      endpoints: Array.isArray(exercise.endpoints) ? exercise.endpoints : [],
      attachment: Array.isArray(exercise.attachment) ? exercise.attachment : [],
    }
  } catch { return null }
}
const endpointLabel = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value)

const app = createApp({
  setup() {
    const state = reactive({
      challenges: [] as Challenge[], detail: null as Detail | null, selectedId: '', tab: 'overview',
      loading: false, saving: false, error: '', notice: '', showCreate: false,
      create: { title: '', category: 'web' as Category, status: 'pending' as Status, description: '', attachments: '', flag: '' },
      edit: { title: '', category: 'web' as Category, status: 'pending' as Status, description: '', attachments: '', flag: '' },
      note: { authorUserId: '', content: '' }, evidence: { type: 'tool_output' as EvidenceType, content: '' },
      task: { ownerUserId: '', expertType: 'general' as 'general' | 'pwn' | 'reverse', prompt: '' }, sharedNote: { content: '', updatedBy: '' }, sharedNoteDirty: false, sharedNoteChallengeId: '', memberName: savedMember(), eventSource: null as EventSource | null,
      platform: { status: null as PlatformStatus | null, loading: false, serverHost: 'https://pro.dasctf.com', accessKey: '', gatewayEndpoint: '' },
    })
    const counts = computed(() => state.challenges.reduce((result: Record<Status, number>, challenge: Challenge) => { result[challenge.status] += 1; return result }, { pending: 0, solving: 0, solved: 0 } as Record<Status, number>))
    const selected = computed(() => state.detail?.challenge ?? state.challenges.find((item: Challenge) => item.challengeId === state.selectedId) ?? null)
    const selectedExercise = computed(() => parseExerciseInfo(selected.value))
    const environmentBlocked = computed(() => Boolean(
      selectedExercise.value?.isNeedInit &&
      (selectedExercise.value.endpoints.length === 0 || selectedExercise.value.isNeedCheck)
    ))
    const attachmentText = (paths: string[]) => paths.join('\n')
    const splitAttachments = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
    const copyChallengeToEdit = (challenge: Challenge) => Object.assign(state.edit, { title: challenge.title, category: challenge.category, status: challenge.status, description: challenge.description, attachments: attachmentText(challenge.attachmentPaths), flag: challenge.flag || '' })
    const notifyError = (error: unknown) => { state.error = error instanceof Error ? error.message : String(error); state.notice = '' }
    const notify = (message: string) => { state.notice = message; state.error = '' }
    const currentMember = () => state.memberName.trim() || 'web-user'
    const saveMember = () => { state.memberName = state.memberName.trim(); try { localStorage.setItem('dsh-ctf-team:member', state.memberName) } catch {} }
    const loadPlatformStatus = async () => {
      try {
        const status = await json('/platform/status') as PlatformStatus
        state.platform.status = status
        if (status.platformHost) state.platform.serverHost = status.platformHost
      } catch (error) { notifyError(error) }
    }
    const configurePlatform = async () => {
      state.platform.loading = true
      try {
        const result = await post('/platform/configure', { serverHost: state.platform.serverHost, accessKey: state.platform.accessKey, gatewayEndpoint: state.platform.gatewayEndpoint || undefined }) as { platform: PlatformStatus }
        state.platform.status = result.platform
        state.platform.accessKey = ''
        notify('平台接入凭证已加载到当前 Harness 进程')
      } catch (error) { notifyError(error) } finally { state.platform.loading = false }
    }
    const clearPlatformCredentials = async () => {
      state.platform.loading = true
      try {
        const result = await post('/platform/clear-credentials', {}) as { platform: PlatformStatus }
        state.platform.status = result.platform
        state.platform.accessKey = ''
        notify('平台运行时凭证已清除')
      } catch (error) { notifyError(error) } finally { state.platform.loading = false }
    }
    const syncPlatform = async () => {
      state.platform.loading = true
      try {
        const result = await post('/platform/sync', {}) as { sync: { notices: number; exercises: number; syncedChallenges: number; score: unknown; rank: unknown } }
        notify(`平台同步完成：公告 ${result.sync.notices}，题目 ${result.sync.exercises}，写入 ${result.sync.syncedChallenges}`)
        await Promise.all([load(true), loadPlatformStatus()])
      } catch (error) { notifyError(error) } finally { state.platform.loading = false }
    }
    const syncExerciseEndpoint = async (silent = false) => {
      const exercise = selectedExercise.value
      if (!exercise?.id) throw new Error('当前题目没有平台 exerciseId')
      const result = await post('/platform/exercise/sync', { exerciseId: exercise.id }) as { result: { endpoints: number; isNeedCheck: boolean } }
      await load(true)
      if (!silent) notify(`题目 endpoint 已同步：${result.result.endpoints} 个${result.result.isNeedCheck ? '（平台仍在准备）' : ''}`)
      return result.result
    }
    const syncCurrentExercise = async () => {
      state.platform.loading = true
      try { await syncExerciseEndpoint(false) } catch (error) { notifyError(error) } finally { state.platform.loading = false }
    }
    const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms))
    const changeExerciseEnv = async (action: 'build' | 'recover') => {
      const exercise = selectedExercise.value
      if (!exercise?.id) { notifyError(new Error('当前题目没有平台 exerciseId')); return }
      const actionText = action === 'build' ? '启动环境' : '恢复环境'
      try {
        await ElMessageBox.confirm(`将对 ${selected.value?.title || exercise.name || exercise.id} 执行“${actionText}”。平台会记录该操作；确认后插件会按平台文档轮询题目详情获取 endpoint。`, `确认${actionText}`, { type: 'warning', confirmButtonText: actionText, cancelButtonText: '取消' })
        state.platform.loading = true
        await post(`/platform/exercise/${action}`, { exerciseId: exercise.id, confirm: true, confirmationText: 'CONFIRM' })
        let result: { endpoints: number; isNeedCheck: boolean } = { endpoints: 0, isNeedCheck: true }
        const attempts = action === 'build' ? 20 : 1
        let ready = false
        for (let index = 0; index < attempts; index++) {
          await wait(index === 0 ? 800 : 2500)
          result = await syncExerciseEndpoint(true)
          if (result.endpoints > 0 && !result.isNeedCheck) { ready = true; break }
          if (!result.isNeedCheck) break
        }
        if (ready) notify(`${actionText}完成，已获取 ${result.endpoints} 个 endpoint`)
        else if (result.isNeedCheck) notify(`${actionText}请求已发送，平台仍在准备环境${result.endpoints ? `（当前已有 ${result.endpoints} 个 endpoint）` : ''}；稍后点击“同步当前题 endpoint”继续轮询`)
        else notify(`${actionText}请求已完成，但平台暂未返回 endpoint，请检查题目状态或重试`)
      } catch (error) { if (error !== 'cancel' && error !== 'close') notifyError(error) }
      finally { state.platform.loading = false }
    }
    const buildExerciseEnv = () => changeExerciseEnv('build')
    const recoverExerciseEnv = () => changeExerciseEnv('recover')
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
      if (environmentBlocked.value) { notifyError(new Error('当前题目环境仍在准备中，请等 endpoint 出现且检查完成后再启动 Agent')); return }
      try { await post('/agent/spawn', { challengeId: state.selectedId, ownerUserId: state.task.ownerUserId || undefined, expertType: state.task.expertType, prompt: state.task.prompt }); state.task.prompt = ''; notify('Agent 任务已提交，日志会实时显示在黑板'); await load(true) }
      catch (error) { notifyError(error) }
    }
    const switchTab = (tab: string) => { state.tab = tab }
    let timer: number | undefined
    onMounted(() => {
      state.eventSource = new EventSource(apiUrl('/events'))
      state.eventSource.onmessage = () => { void load(true) }
      state.eventSource.onerror = () => { /* EventSource will reconnect; polling below keeps the view fresh. */ }
      void load(false)
      void loadPlatformStatus()
      timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void load(true) }, 15000)
    })
    onBeforeUnmount(() => { if (timer !== undefined) window.clearInterval(timer); state.eventSource?.close() })
    return { state, counts, selected, selectedExercise, environmentBlocked, categoryLabel, statusLabel, evidenceLabel, formatTime, endpointLabel, load, selectChallenge, createChallenge, updateChallenge, deleteChallenge, saveSharedNote, addEvidence, startTask, switchTab, saveMember, apiUrl, loadPlatformStatus, configurePlatform, clearPlatformCredentials, syncPlatform, syncCurrentExercise, buildExerciseEnv, recoverExerciseEnv }
  },
  template: `
  <el-container class="ctf-app">
    <el-header class="ctf-topbar">
      <div><h1>🏁 CTF Team</h1><p>同一 Harness 地址下，所有打开面板的队员共享同一份 SQLite 数据</p></div>
      <div class="top-actions"><el-input v-model="state.memberName" @change="saveMember" placeholder="你的队员名" style="width: 150px" /><el-button @click="load(true)" :loading="state.loading">刷新</el-button><el-tag type="success">SSE 实时同步</el-tag></div>
    </el-header>
    <el-alert v-if="state.error" :title="state.error" type="error" show-icon closable @close="state.error=''" />
    <el-alert v-if="state.notice" :title="state.notice" type="success" show-icon closable @close="state.notice=''" />
    <el-card class="platform-panel" shadow="never">
      <div class="platform-heading"><div><h2>西湖论剑 DASCTF 平台接入</h2><p>Server Host 与 AccessKey 只加载到当前 Harness 进程；模型原始完整 URL 按赛事手册白名单校验。</p></div><el-button @click="loadPlatformStatus" :loading="state.platform.loading">刷新状态</el-button></div>
      <el-form class="platform-form" label-position="top" @submit.prevent="configurePlatform">
        <div class="platform-grid"><el-form-item label="Server Host"><el-input v-model="state.platform.serverHost" placeholder="https://pro.dasctf.com" /></el-form-item><el-form-item label="AccessKey"><el-input v-model="state.platform.accessKey" type="password" show-password autocomplete="off" placeholder="ak_live_..." /></el-form-item><el-form-item label="模型原始完整 URL（可选）"><el-input v-model="state.platform.gatewayEndpoint" placeholder="https://api.deepseek.com/v1/chat/completions" /></el-form-item></div>
        <div class="platform-actions"><el-button type="primary" native-type="submit" :loading="state.platform.loading">加载凭证</el-button><el-button @click="clearPlatformCredentials" :loading="state.platform.loading">清除运行时凭证</el-button><el-button type="success" plain @click="syncPlatform" :loading="state.platform.loading">同步平台数据</el-button><el-button tag="a" :href="apiUrl('/platform/report')" target="_blank">审计报告</el-button></div>
        <div class="platform-status"><el-tag :type="state.platform.status?.accessKeyConfigured ? 'success' : 'info'">AccessKey：{{ state.platform.status?.accessKeyConfigured ? '已加载' : '未加载' }}</el-tag><el-tag :type="state.platform.status?.gatewayEndpointAllowed ? 'success' : (state.platform.status?.gatewayEndpointConfigured ? 'danger' : 'info')">模型 URL：{{ state.platform.status?.gatewayEndpointAllowed ? '白名单通过' : (state.platform.status?.gatewayEndpointConfigured ? '待修正' : '未填写') }}</el-tag><el-tag :type="state.platform.status?.event?.active ? 'success' : 'warning'">赛事窗口：{{ state.platform.status?.event?.active ? '当前可操作' : '当前仅同步/记录' }}</el-tag><span v-if="state.platform.status?.platformHost">{{ state.platform.status.platformHost }} · 比赛 {{ state.platform.status.competitionId }} / 阶段 {{ state.platform.status.stageId }}</span></div>
      </el-form>
    </el-card>
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
        <el-alert v-if="environmentBlocked" title="当前题目环境仍未准备完成：需要等平台检查完成且返回 endpoint，Agent 才能开始解题。" type="warning" show-icon :closable="false" class="env-alert" />
        <div v-if="selectedExercise" class="exercise-box"><div class="exercise-meta"><el-tag :type="selectedExercise.isNeedInit ? 'warning' : 'info'">{{ selectedExercise.isNeedInit ? '需初始化环境' : '无需初始化' }}</el-tag><el-tag>exerciseId {{ selectedExercise.id || '-' }}</el-tag><el-tag>{{ selectedExercise.endpointType || 'endpoint' }}</el-tag><el-tag :type="selectedExercise.isNeedCheck ? 'warning' : 'info'">{{ selectedExercise.isNeedCheck ? '环境准备中' : '检查完成' }}</el-tag><el-tag :type="selectedExercise.endpoints.length ? 'success' : 'danger'">endpoint {{ selectedExercise.endpoints.length }}</el-tag></div><div v-if="selectedExercise.endpoints.length" class="endpoint-list"><code v-for="endpoint in selectedExercise.endpoints" :key="endpointLabel(endpoint)">{{ endpointLabel(endpoint) }}</code></div><div class="platform-actions"><el-button type="primary" plain @click="buildExerciseEnv" :loading="state.platform.loading" :disabled="!selectedExercise.id">启动环境</el-button><el-button plain @click="recoverExerciseEnv" :loading="state.platform.loading" :disabled="!selectedExercise.id">恢复环境</el-button><el-button type="success" plain @click="syncCurrentExercise" :loading="state.platform.loading" :disabled="!selectedExercise.id">同步当前题 endpoint</el-button></div></div>
        <el-tabs v-model="state.tab" @tab-change="switchTab">
          <el-tab-pane label="题目详情" name="overview"><el-form label-position="top" @submit.prevent="updateChallenge"><el-form-item label="题目名称"><el-input v-model="state.edit.title" /></el-form-item><div class="form-grid"><el-form-item label="分类"><el-select v-model="state.edit.category"><el-option v-for="(label,key) in categoryLabel" :key="key" :label="label" :value="key" /></el-select></el-form-item><el-form-item label="状态"><el-select v-model="state.edit.status"><el-option v-for="(label,key) in statusLabel" :key="key" :label="label" :value="key" /></el-select></el-form-item></div><el-form-item label="描述"><el-input v-model="state.edit.description" type="textarea" :rows="5" /></el-form-item><el-form-item label="附件路径"><el-input v-model="state.edit.attachments" type="textarea" :rows="3" /></el-form-item><el-form-item label="Flag"><el-input v-model="state.edit.flag" show-password /></el-form-item><el-button type="primary" native-type="submit" :loading="state.saving">保存修改</el-button></el-form></el-tab-pane>
          <el-tab-pane label="共享笔记" name="notes"><el-alert title="这是每道题唯一的一份共享正文：所有队员都能编辑和查看，保存后其他浏览器通过 SSE 自动刷新。" type="info" :closable="false" /><el-alert v-if="state.sharedNoteDirty" title="你正在编辑尚未保存的本地内容；其他队员的更新会在你保存或放弃编辑后显示。" type="warning" :closable="false" class="shared-note-warning" /><el-form label-position="top" @submit.prevent="saveSharedNote" class="shared-note-form"><el-form-item label="解题思路 / 踩坑记录 / 备忘"><el-input v-model="state.sharedNote.content" @input="state.sharedNoteDirty = true" type="textarea" :rows="18" placeholder="全队共同维护这份笔记……" /></el-form-item><div class="shared-note-meta"><span v-if="state.detail?.sharedNote">最后编辑：{{ state.detail.sharedNote.updatedBy }} · {{ formatTime(state.detail.sharedNote.updatedAt) }}</span><span v-else>尚未保存</span><el-button type="primary" native-type="submit" :loading="state.saving">保存共享笔记</el-button></div></el-form></el-tab-pane>
          <el-tab-pane label="证据库" name="evidence"><div v-for="item in state.detail?.evidence" :key="item.id" class="record-card"><div><el-tag>{{ evidenceLabel[item.type] }}</el-tag><small>{{ formatTime(item.createdAt) }}</small></div><pre>{{ item.content }}</pre></div><el-empty v-if="!state.detail?.evidence.length" description="暂无证据" /><el-form label-position="top" @submit.prevent="addEvidence"><el-form-item label="类型"><el-select v-model="state.evidence.type"><el-option v-for="(label,key) in evidenceLabel" :key="key" :label="label" :value="key" /></el-select></el-form-item><el-form-item label="工具输出 / 文件提取结果 / 命令日志"><el-input v-model="state.evidence.content" type="textarea" :rows="6" /></el-form-item><el-button type="primary" native-type="submit">归档证据</el-button></el-form></el-tab-pane>
          <el-tab-pane label="Agent 日志" name="thoughts"><div v-for="item in state.detail?.thoughts" :key="item.id" class="record-card"><div><el-tag type="warning">{{ item.source }}</el-tag><small>{{ formatTime(item.createdAt) }}</small></div><p class="content">{{ item.content }}</p></div><el-empty v-if="!state.detail?.thoughts.length" description="Agent 运行日志会显示在这里" /></el-tab-pane>
          <el-tab-pane label="Agent 任务" name="tasks"><el-alert v-if="environmentBlocked" title="请先等上方环境检查完成并同步 endpoint，避免 Agent 盲查本地仓库或本机端口。" type="warning" show-icon :closable="false" class="env-alert" /><div v-for="item in state.detail?.tasks" :key="item.taskId" class="record-card"><div><el-tag :type="item.done ? 'success' : 'warning'">{{ item.done ? '已完成' : '运行中' }}</el-tag><small>{{ item.ownerUserId }} · {{ item.expertType }} · {{ formatTime(item.createdAt) }}</small></div><p><b>Prompt：</b>{{ item.prompt }}</p><pre v-if="item.result">{{ item.result }}</pre></div><el-empty v-if="!state.detail?.tasks.length" description="暂无 Agent 任务" /><el-form label-position="top" @submit.prevent="startTask"><el-form-item label="Owner"><el-input v-model="state.task.ownerUserId" placeholder="默认使用当前队员标识" /></el-form-item><el-form-item label="专家方向"><el-select v-model="state.task.expertType"><el-option label="通用" value="general" /><el-option label="Pwn" value="pwn" /><el-option label="Reverse" value="reverse" /></el-select></el-form-item><el-form-item label="任务 Prompt"><el-input v-model="state.task.prompt" type="textarea" :rows="6" placeholder="例如：审计该题附件中的源码，给出漏洞链和验证步骤" /></el-form-item><el-button type="primary" native-type="submit" :disabled="environmentBlocked">{{ environmentBlocked ? '等待环境准备完成' : '启动 Agent 任务' }}</el-button></el-form></el-tab-pane>
        </el-tabs>
      </el-card>
      <el-card v-else class="challenge-detail" shadow="never"><el-empty description="从左侧添加或选择一道题目" /></el-card>
    </el-main>
  </el-container>`,
})

app.use(ElementPlus)
app.mount('#app')
