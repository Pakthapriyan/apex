import type {
  DailyQuest,
  Domain,
  JarvisAction,
  ProjectMission,
  SkillNode,
  UserProfile,
} from '../types/learning';

export type LiveVoiceState =
  | 'disconnected'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error';

export interface LiveVoiceContextPayload {
  profile: Pick<
    UserProfile,
    'weeklyHoursTarget' | 'streakDays' | 'rotationMap' | 'domainFocusMinutes'
  >;
  activeProject: ProjectMission | null;
  skills: Array<{
    domain: Domain;
    title: string;
    tier: string;
    priority: string;
    mastery: number;
    description?: string;
    studyBrief?: string;
    labPrompt?: string;
  }>;
  todayQuests: Array<{
    id: string;
    title: string;
    domain: Domain;
    questType: string;
    rank: string;
    status: string;
    objective: string;
    masteryChecklist: string[];
    linkedSkillTitle: string;
    estimatedMinutes: number;
    xpReward: number;
  }>;
  currentScreen: {
    activePage: string;
    profileDomainFilter?: string;
    selectedSkillTitle?: string | null;
  };
}

export interface LiveVoiceCallbacks {
  onStateChange: (state: LiveVoiceState) => void;
  onInputTranscript?: (text: string) => void;
  onOutputTranscript?: (text: string) => void;
  onTurnComplete?: (turn: { userText: string; assistantText: string }) => void;
  onActions?: (actions: JarvisAction[]) => void;
  onError?: (message: string) => void;
}

function downsampleBuffer(
  input: Float32Array,
  inputRate: number,
  outputRate: number
): Float32Array {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.min(
      input.length,
      Math.round((offsetResult + 1) * ratio)
    );
    let accum = 0;
    let count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer; i++) {
      accum += input[i];
      count += 1;
    }
    result[offsetResult] = count > 0 ? accum / count : 0;
    offsetResult += 1;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

function floatToPcm16Base64(float32: Float32Array): string {
  const bytes = new Uint8Array(float32.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < float32.length; i++) {
    const clamped = Math.max(-1, Math.min(1, float32[i]));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(i * 2, int16, true);
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64Pcm16ToFloat32(base64: string): Float32Array {
  const binary = atob(base64);
  const byteLen = binary.length;
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < byteLen; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  const view = new DataView(bytes.buffer);
  const sampleCount = Math.floor(byteLen / 2);
  const float32 = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }
  return float32;
}

export function buildLiveVoiceContext(params: {
  profile: UserProfile;
  activeProject: ProjectMission | null;
  skills: SkillNode[];
  todayQuests: DailyQuest[];
  currentScreen: {
    activePage: string;
    profileDomainFilter?: string;
    selectedSkillTitle?: string | null;
  };
}): LiveVoiceContextPayload {
  return {
    profile: {
      weeklyHoursTarget: params.profile.weeklyHoursTarget,
      streakDays: params.profile.streakDays,
      rotationMap: params.profile.rotationMap,
      domainFocusMinutes: params.profile.domainFocusMinutes,
    },
    activeProject: params.activeProject,
    skills: params.skills.map((s) => ({
      domain: s.domain,
      title: s.title,
      tier: s.tier,
      priority: s.priority || 'Normal',
      mastery: s.mastery,
      description: s.description,
      studyBrief: s.studyBrief?.slice(0, 700),
      labPrompt: s.labPrompt?.slice(0, 500),
    })),
    todayQuests: params.todayQuests.map((q) => ({
      id: q.id,
      title: q.title,
      domain: q.domain,
      questType: q.questType,
      rank: q.rank,
      status: q.status,
      objective: q.objective,
      masteryChecklist: q.masteryChecklist,
      linkedSkillTitle: q.linkedSkillTitle,
      estimatedMinutes: q.estimatedMinutes,
      xpReward: q.xpReward,
    })),
    currentScreen: params.currentScreen,
  };
}

export class LiveJarvisClient {
  private ws: WebSocket | null = null;
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private activeSources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private muted = false;
  private closed = false;
  private userTranscriptBuf = '';
  private assistantTranscriptBuf = '';
  private callbacks: LiveVoiceCallbacks;

  constructor(callbacks: LiveVoiceCallbacks) {
    this.callbacks = callbacks;
  }

  public setMuted(nextMuted: boolean) {
    this.muted = nextMuted;
  }

  public async connect(contextPayload: LiveVoiceContextPayload): Promise<void> {
    if (this.ws) {
      this.disconnect();
    }
    this.closed = false;
    this.userTranscriptBuf = '';
    this.assistantTranscriptBuf = '';
    this.nextStartTime = 0;
    this.callbacks.onStateChange('connecting');

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      !navigator.mediaDevices.getUserMedia
    ) {
      const msg = 'Microphone access is not available in this browser context.';
      this.callbacks.onStateChange('error');
      this.callbacks.onError?.(msg);
      return;
    }

    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (err) {
      const msg =
        err instanceof Error
          ? `Microphone permission denied or unavailable: ${err.message}`
          : 'Microphone permission denied.';
      this.callbacks.onStateChange('error');
      this.callbacks.onError?.(msg);
      return;
    }

    if (this.closed) {
      this.cleanupAudioOnly();
      return;
    }

    try {
      this.inputAudioCtx = new AudioContext({ sampleRate: 16000 });
      this.outputAudioCtx = new AudioContext({ sampleRate: 24000 });
      if (this.inputAudioCtx.state === 'suspended') {
        await this.inputAudioCtx.resume();
      }
      if (this.outputAudioCtx.state === 'suspended') {
        await this.outputAudioCtx.resume();
      }
    } catch (err) {
      this.cleanupAudioOnly();
      const msg = err instanceof Error ? err.message : 'Unable to initialize Web Audio contexts.';
      this.callbacks.onStateChange('error');
      this.callbacks.onError?.(msg);
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/live-jarvis`;
    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (this.closed) {
        ws.close();
        return;
      }
      ws.send(JSON.stringify({ type: 'init', context: contextPayload }));
      this.startMicCapture();
    };

    ws.onmessage = (event) => {
      if (this.closed) return;
      try {
        const msg = JSON.parse(String(event.data)) as {
          type: string;
          audio?: string;
          text?: string;
          status?: LiveVoiceState;
          uiActions?: JarvisAction[];
          message?: string;
        };

        if (msg.type === 'ready') {
          this.callbacks.onStateChange('listening');
        } else if (msg.type === 'status' && msg.status) {
          this.callbacks.onStateChange(msg.status);
        } else if (msg.type === 'audio' && msg.audio) {
          this.callbacks.onStateChange('speaking');
          this.playPcmChunk(msg.audio);
        } else if (msg.type === 'interrupted') {
          this.stopOutputPlayback();
          this.callbacks.onStateChange('listening');
        } else if (msg.type === 'inputTranscript' && msg.text) {
          this.userTranscriptBuf = `${this.userTranscriptBuf} ${msg.text}`.trim();
          this.callbacks.onInputTranscript?.(this.userTranscriptBuf);
        } else if (msg.type === 'outputTranscript' && msg.text) {
          this.assistantTranscriptBuf = `${this.assistantTranscriptBuf}${msg.text}`;
          this.callbacks.onOutputTranscript?.(this.assistantTranscriptBuf.trim());
        } else if (msg.type === 'turnComplete') {
          const userText = this.userTranscriptBuf.trim();
          const assistantText = this.assistantTranscriptBuf.trim();
          if (userText || assistantText) {
            this.callbacks.onTurnComplete?.({ userText, assistantText });
          }
          this.userTranscriptBuf = '';
          this.assistantTranscriptBuf = '';
          this.callbacks.onInputTranscript?.('');
          this.callbacks.onOutputTranscript?.('');
          if (this.activeSources.size === 0) {
            this.callbacks.onStateChange('listening');
          }
        } else if (msg.type === 'actions' && Array.isArray(msg.uiActions)) {
          this.callbacks.onActions?.(msg.uiActions);
        } else if (msg.type === 'error') {
          const errMsg = msg.message || 'Live voice session encountered an error.';
          this.callbacks.onError?.(errMsg);
          this.disconnect('error');
        }
      } catch {
        // Ignore malformed socket frames cleanly
      }
    };

    ws.onerror = () => {
      if (this.closed) return;
      this.callbacks.onError?.('Live voice WebSocket connection failed.');
      this.disconnect('error');
    };

    ws.onclose = () => {
      if (!this.closed) {
        this.disconnect('disconnected');
      }
    };
  }

  public sendText(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'text', text: trimmed }));
  }

  private startMicCapture() {
    if (!this.inputAudioCtx || !this.mediaStream) return;
    const ctx = this.inputAudioCtx;
    const source = ctx.createMediaStreamSource(this.mediaStream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);

    processor.onaudioprocess = (e) => {
      if (this.closed || this.muted || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }
      const raw = e.inputBuffer.getChannelData(0);
      const downsampled = downsampleBuffer(raw, ctx.sampleRate, 16000);
      const base64 = floatToPcm16Base64(downsampled);
      this.ws.send(JSON.stringify({ type: 'audio', audio: base64 }));
    };

    source.connect(processor);
    processor.connect(ctx.destination);
    this.sourceNode = source;
    this.processor = processor;
  }

  private playPcmChunk(base64Audio: string) {
    if (!this.outputAudioCtx) return;
    const ctx = this.outputAudioCtx;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }

    const samples = base64Pcm16ToFloat32(base64Audio);
    if (samples.length === 0) return;

    const buffer = ctx.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(new Float32Array(samples), 0);

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);

    const startAt = Math.max(ctx.currentTime + 0.015, this.nextStartTime);
    this.nextStartTime = startAt + buffer.duration;
    this.activeSources.add(src);

    src.onended = () => {
      this.activeSources.delete(src);
      if (this.activeSources.size === 0 && !this.closed) {
        this.callbacks.onStateChange('listening');
      }
    };

    src.start(startAt);
  }

  private stopOutputPlayback() {
    for (const src of this.activeSources) {
      try {
        src.stop();
      } catch {
        // Already stopped
      }
    }
    this.activeSources.clear();
    this.nextStartTime = 0;
  }

  private cleanupAudioOnly() {
    this.stopOutputPlayback();
    try {
      this.processor?.disconnect();
    } catch {
      // Ignore
    }
    try {
      this.sourceNode?.disconnect();
    } catch {
      // Ignore
    }
    this.processor = null;
    this.sourceNode = null;

    if (this.mediaStream) {
      for (const track of this.mediaStream.getTracks()) {
        track.stop();
      }
      this.mediaStream = null;
    }

    if (this.inputAudioCtx) {
      void this.inputAudioCtx.close().catch(() => {});
      this.inputAudioCtx = null;
    }
    if (this.outputAudioCtx) {
      void this.outputAudioCtx.close().catch(() => {});
      this.outputAudioCtx = null;
    }
  }

  public disconnect(finalState: LiveVoiceState = 'disconnected') {
    if (this.closed && finalState === 'disconnected') return;
    this.closed = true;

    const userText = this.userTranscriptBuf.trim();
    const assistantText = this.assistantTranscriptBuf.trim();
    if (userText || assistantText) {
      this.callbacks.onTurnComplete?.({ userText, assistantText });
    }
    this.userTranscriptBuf = '';
    this.assistantTranscriptBuf = '';

    if (this.ws) {
      try {
        if (
          this.ws.readyState === WebSocket.OPEN ||
          this.ws.readyState === WebSocket.CONNECTING
        ) {
          this.ws.close();
        }
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }

    this.cleanupAudioOnly();
    this.callbacks.onStateChange(finalState);
  }
}
