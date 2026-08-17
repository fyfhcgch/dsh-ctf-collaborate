export interface TeamP2POptions {
  /** Optional STUN/TURN servers for peers that are not on the same LAN. */
  iceServers?: RTCIceServer[]
  /** ICE policy can be set to `relay` when a TURN service is required. */
  iceTransportPolicy?: RTCIceTransportPolicy
}

export interface TeamP2PRemote {
  identity(): Promise<{ teamId: string; peerId: string; createdAt: number }>
  changes(input?: { afterSequence?: number; limit?: number }): Promise<{ nextCursor: number; hasMore: boolean; operations: TeamOperation[] }>
  applyOperations(input: { operations: TeamOperation[] }): Promise<{ accepted: string[]; ignored: string[]; pending: TeamOperation[] }>
  syncStatus(): Promise<{ teamId: string; peerId: string; operationCursor: number; operationCount: number }>
}

export type TeamOperationKind = 'challenge_upsert' | 'challenge_delete' | 'note_add' | 'thought_add' | 'evidence_add' | 'task_upsert'
export interface TeamOperation {
  sequence?: number
  opId: string
  peerId: string
  kind: TeamOperationKind
  payload: unknown
  createdAt: number
}

export interface TeamP2PInvite {
  version: 1
  mode: 'offer' | 'answer'
  teamId: string
  peerId: string
  sessionId: string
  description: RTCSessionDescriptionInit
}

export interface TeamP2PPeerStatus {
  peerId: string
  state: RTCPeerConnectionState | 'new'
  connectedAt?: number
  lastSeenAt?: number
}

export interface TeamP2PStatus {
  enabled: boolean
  teamId?: string
  peerId?: string
  peers: TeamP2PPeerStatus[]
}

type Frame =
  | { type: 'hello'; teamId: string; peerId: string; sessionId: string }
  | { type: 'ops'; cursor: number; operations: TeamOperation[] }
  | { type: 'ops-ack'; cursor: number; pending: TeamOperation[] }
  | { type: 'presence'; peerId: string; at: number }

interface PeerConnection {
  peerId?: string
  pc: RTCPeerConnection
  channel?: RTCDataChannel
  sentCursor: number
  receivedCursor: number
  connectedAt?: number
  lastSeenAt?: number
  closed: boolean
}

const INVITE_PREFIX = 'dsh-ctf-team:'

/** Browser-side WebRTC mesh and operation-log synchronizer. */
export class TeamP2PController {
  private readonly connections = new Set<PeerConnection>()
  private readonly pending = new Map<string, PeerConnection>()
  private identityValue?: { teamId: string; peerId: string; createdAt: number }
  private pollTimer?: number
  private presenceTimer?: number
  private disposed = false
  private listeners = new Set<(status: TeamP2PStatus) => void>()

  constructor(
    private readonly remote: TeamP2PRemote,
    private readonly log: (message: string) => void = () => {},
    private readonly options: TeamP2POptions = {},
  ) {}

  async ready(): Promise<TeamP2PStatus> {
    if (typeof RTCPeerConnection === 'undefined') return this.status()
    this.identityValue ??= await this.remote.identity()
    this.pollTimer = window.setInterval(() => { void this.syncAll() }, 1000)
    this.presenceTimer = window.setInterval(() => this.sendPresence(), 3000)
    return this.status()
  }

  async createInvite(): Promise<string> {
    const identity = await this.identity()
    const sessionId = crypto.randomUUID()
    const connection = this.makeConnection(sessionId)
    const channel = connection.pc.createDataChannel('dsh-ctf-team', { ordered: true })
    this.bindChannel(connection, channel)
    const offer = await connection.pc.createOffer()
    await connection.pc.setLocalDescription(offer)
    await waitForIceGathering(connection.pc)
    this.pending.set(sessionId, connection)
    return encodeInvite({ version: 1, mode: 'offer', teamId: identity.teamId, peerId: identity.peerId, sessionId, description: connection.pc.localDescription ?? offer })
  }

  async acceptInvite(value: string): Promise<string> {
    const invite = decodeInvite(value)
    if (invite.mode !== 'offer') throw new Error('Expected an offer invite')
    const identity = await this.identity()
    if (invite.teamId !== identity.teamId) throw new Error('Team ID does not match')
    const connection = this.makeConnection(invite.sessionId)
    await connection.pc.setRemoteDescription(invite.description)
    const answer = await connection.pc.createAnswer()
    await connection.pc.setLocalDescription(answer)
    await waitForIceGathering(connection.pc)
    // The data channel opens only after the offerer applies this answer.
    // Waiting here would deadlock manual copy/paste signaling. The
    // ondatachannel handler installed by makeConnection() will bind it when
    // the ICE/DTLS handshake completes.
    return encodeInvite({ version: 1, mode: 'answer', teamId: identity.teamId, peerId: identity.peerId, sessionId: invite.sessionId, description: connection.pc.localDescription ?? answer })
  }

  async completeInvite(value: string): Promise<void> {
    const invite = decodeInvite(value)
    if (invite.mode !== 'answer') throw new Error('Expected an answer invite')
    const identity = await this.identity()
    if (invite.teamId !== identity.teamId) throw new Error('Team ID does not match')
    const connection = this.pending.get(invite.sessionId)
    if (!connection) throw new Error('No pending offer for this session')
    await connection.pc.setRemoteDescription(invite.description)
    this.pending.delete(invite.sessionId)
  }

  status(): TeamP2PStatus {
    return {
      enabled: typeof RTCPeerConnection !== 'undefined',
      ...(this.identityValue ? { teamId: this.identityValue.teamId, peerId: this.identityValue.peerId } : {}),
      peers: [...this.connections].filter((item) => !item.closed).map((item) => ({
        peerId: item.peerId ?? 'connecting', state: item.pc.connectionState || 'new',
        ...(item.connectedAt ? { connectedAt: item.connectedAt } : {}),
        ...(item.lastSeenAt ? { lastSeenAt: item.lastSeenAt } : {}),
      })),
    }
  }

  subscribe(listener: (status: TeamP2PStatus) => void): () => void {
    this.listeners.add(listener)
    listener(this.status())
    return () => this.listeners.delete(listener)
  }

  disconnect(peerId?: string): void {
    for (const connection of [...this.connections, ...this.pending.values()]) {
      if (peerId && connection.peerId !== peerId) continue
      connection.closed = true
      connection.channel?.close()
      connection.pc.close()
      this.connections.delete(connection)
    }
    this.emitStatus()
  }

  dispose(): void {
    this.disposed = true
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer)
    if (this.presenceTimer !== undefined) window.clearInterval(this.presenceTimer)
    this.disconnect()
    this.listeners.clear()
  }

  private async identity() {
    this.identityValue ??= await this.remote.identity()
    return this.identityValue
  }

  private makeConnection(sessionId: string): PeerConnection {
    const connection: PeerConnection = {
      pc: new RTCPeerConnection({
        ...(this.options.iceServers ? { iceServers: this.options.iceServers } : {}),
        ...(this.options.iceTransportPolicy ? { iceTransportPolicy: this.options.iceTransportPolicy } : {}),
      }),
      sentCursor: 0,
      receivedCursor: 0,
      closed: false,
    }
    this.connections.add(connection)
    connection.pc.onconnectionstatechange = () => {
      if (connection.pc.connectionState === 'connected') connection.connectedAt ??= Date.now()
      if (['failed', 'closed', 'disconnected'].includes(connection.pc.connectionState)) {
        connection.closed = true
        this.connections.delete(connection)
      }
      this.emitStatus()
    }
    connection.pc.ondatachannel = (event) => this.bindChannel(connection, event.channel)
    this.pending.set(sessionId, connection)
    return connection
  }

  private bindChannel(connection: PeerConnection, channel: RTCDataChannel): void {
    connection.channel = channel
    channel.onopen = () => {
      void this.sendHello(connection)
      this.emitStatus()
    }
    channel.onclose = () => { connection.closed = true; this.emitStatus() }
    channel.onerror = () => this.log('WebRTC data channel error')
    channel.onmessage = (event) => { void this.receive(connection, event.data) }
  }

  private async sendHello(connection: PeerConnection): Promise<void> {
    const identity = await this.identity()
    this.send(connection, { type: 'hello', teamId: identity.teamId, peerId: identity.peerId, sessionId: crypto.randomUUID() })
    await this.syncPeer(connection, true)
  }

  private async receive(connection: PeerConnection, raw: unknown): Promise<void> {
    let frame: Frame
    try { frame = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer)) as Frame } catch { return }
    if (frame.type === 'hello') {
      const identity = await this.identity()
      if (frame.teamId !== identity.teamId) { connection.pc.close(); return }
      connection.peerId = frame.peerId
      connection.lastSeenAt = Date.now()
      this.emitStatus()
      await this.syncPeer(connection, true)
      return
    }
    if (frame.type === 'presence') {
      if (!connection.peerId || connection.peerId !== frame.peerId) return
      connection.lastSeenAt = frame.at
      this.emitStatus()
      return
    }
    if (frame.type === 'ops') {
      const result = await this.remote.applyOperations({ operations: frame.operations })
      connection.receivedCursor = Math.max(connection.receivedCursor, frame.cursor)
      this.send(connection, { type: 'ops-ack', cursor: frame.cursor, pending: result.pending })
      this.emitSyncEvent(result.accepted.length)
      return
    }
    if (frame.type === 'ops-ack') {
      connection.sentCursor = Math.max(connection.sentCursor, frame.cursor)
      if (frame.pending.length) {
        // Roots are sent first by the Host; retry pending children on the next tick.
        const roots = (await this.remote.changes({ afterSequence: 0, limit: 1000 })).operations
          .filter((operation) => frame.pending.some((item) => item.opId === operation.opId))
        if (roots.length) this.send(connection, { type: 'ops', cursor: frame.cursor, operations: roots })
      }
    }
  }

  private async syncAll(): Promise<void> {
    if (this.disposed) return
    for (const connection of this.connections) {
      if (connection.closed || connection.channel?.readyState !== 'open') continue
      await this.syncPeer(connection, false)
    }
  }

  private async syncPeer(connection: PeerConnection, initial: boolean): Promise<void> {
    if (connection.channel?.readyState !== 'open') return
    const batch = await this.remote.changes({ afterSequence: initial ? 0 : connection.sentCursor, limit: 200 })
    if (batch.operations.length) {
      this.send(connection, { type: 'ops', cursor: batch.nextCursor, operations: batch.operations })
      // The receiver is idempotent. Advancing here prevents repeated floods;
      // pending records are requested again by its acknowledgement.
      connection.sentCursor = Math.max(connection.sentCursor, batch.nextCursor)
    }
  }

  private sendPresence(): void {
    for (const connection of this.connections) {
      if (connection.channel?.readyState !== 'open') continue
      const identity = this.identityValue
      if (identity) this.send(connection, { type: 'presence', peerId: identity.peerId, at: Date.now() })
    }
  }

  private send(connection: PeerConnection, frame: Frame): void {
    if (connection.channel?.readyState === 'open') connection.channel.send(JSON.stringify(frame))
  }

  private emitStatus(): void {
    const status = this.status()
    for (const listener of this.listeners) listener(status)
    window.dispatchEvent(new CustomEvent('dsh-ctf-team:p2p-status', { detail: status }))
  }

  private emitSyncEvent(count: number): void {
    window.dispatchEvent(new CustomEvent('dsh-ctf-team:sync', { detail: { count, status: this.status() } }))
  }
}

function encodeInvite(invite: TeamP2PInvite): string {
  const json = JSON.stringify(invite)
  return `${INVITE_PREFIX}${base64UrlEncode(json)}`
}

function decodeInvite(value: string): TeamP2PInvite {
  if (typeof value !== 'string' || !value.startsWith(INVITE_PREFIX)) throw new Error('Invalid CTF Team invite')
  let parsed: unknown
  try { parsed = JSON.parse(base64UrlDecode(value.slice(INVITE_PREFIX.length))) } catch { throw new Error('Invalid CTF Team invite payload') }
  if (parsed === null || typeof parsed !== 'object') throw new Error('Invalid CTF Team invite payload')
  const invite = parsed as Partial<TeamP2PInvite>
  if (invite.version !== 1 || (invite.mode !== 'offer' && invite.mode !== 'answer') || typeof invite.teamId !== 'string' || typeof invite.peerId !== 'string' || typeof invite.sessionId !== 'string' || !invite.description) throw new Error('Invalid CTF Team invite fields')
  return invite as TeamP2PInvite
}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
function base64UrlDecode(value: string): string {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', done); resolve() } }
    pc.addEventListener('icegatheringstatechange', done)
    window.setTimeout(() => { pc.removeEventListener('icegatheringstatechange', done); resolve() }, 5000)
  })
}
