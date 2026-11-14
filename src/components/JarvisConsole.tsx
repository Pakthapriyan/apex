import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CheckSquare,
  Compass,
  Copy,
  HelpCircle,
  Layers,
  ListChecks,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Send,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import {
  buildLiveVoiceContext,
  LiveJarvisClient,
  type LiveVoiceState,
} from '../lib/liveVoiceClient';
import type {
  DailyQuest,
  Domain,
  JarvisAction,
  JarvisMessage,
  ProjectMission,
  SimplePage,
  SkillNode,
  UserProfile,
} from '../types/learning';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  0: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  results: ArrayLike<SpeechRecognitionResultLike>;
}

interface SpeechRecognitionInstanceLike {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionInstanceLike;

interface JarvisConsoleProps {
  open: boolean;
  loading: boolean;
  messages: JarvisMessage[];
  activePage: SimplePage;
  profileDomainFilter: Domain | 'All';
  selectedSkillTitle: string | null;
  profile: UserProfile;
  skills: SkillNode[];
  todayQuests: DailyQuest[];
  activeProject: ProjectMission | null;
  pendingQuestsCount: number;
  onToggleOpen: (open: boolean) => void;
  onSendMessage: (message: string) => void;
  onExecuteActions: (actions: JarvisAction[]) => string[];
  onAddMessage: (msg: JarvisMessage) => void;
  onClearHistory?: () => void;
  onAnalyzeNow: () => void;
}

function renderInlineRichText(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const tokenRegex = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let lastIdx = 0;
  let match: RegExpExecArray | null;
  let tokenIndex = 0;

  while ((match = tokenRegex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index));
    }
    const token = match[0];
    if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(
        <strong key={`${keyPrefix}-b-${tokenIndex++}`} className="font-semibold text-slate-50">
          {token.slice(2, -2)}
        </strong>
      );
    } else if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(
        <code
          key={`${keyPrefix}-c-${tokenIndex++}`}
          className="px-1.5 py-0.5 mx-0.5 rounded bg-[#121824] border border-slate-700/80 font-mono text-[11px] text-sky-200"
        >
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith('*') && token.endsWith('*')) {
      parts.push(
        <em key={`${keyPrefix}-i-${tokenIndex++}`} className="italic text-slate-100">
          {token.slice(1, -1)}
        </em>
      );
    }
    lastIdx = tokenRegex.lastIndex;
  }

  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx));
  }

  return parts.length > 0 ? parts : [text];
}

const FormattedJarvisContent: React.FC<{ content: string }> = ({ content }) => {
  const blocks = useMemo(() => {
    const normalized = (content || '').replace(/\r\n/g, '\n').trim();
    if (!normalized) return [];

    const out: Array<
      | { kind: 'heading'; text: string }
      | { kind: 'bullet'; items: string[] }
      | { kind: 'numbered'; items: Array<{ num: string; text: string }> }
      | { kind: 'code'; code: string }
      | { kind: 'paragraph'; text: string }
    > = [];

    const lines = normalized.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i].trim();

      if (!line) {
        i += 1;
        continue;
      }

      if (line.startsWith('```')) {
        const codeLines: string[] = [];
        i += 1;
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i += 1;
        }
        i += 1;
        if (codeLines.length > 0) {
          out.push({ kind: 'code', code: codeLines.join('\n') });
        }
        continue;
      }

      const headingMatch = line.match(/^#{1,4}\s+(.+)$/);
      if (headingMatch) {
        out.push({ kind: 'heading', text: headingMatch[1].trim() });
        i += 1;
        continue;
      }

      // Single-line section label ending in ':' followed by bullets/lines (e.g. "5-Domain Telemetry:")
      if (
        /^[A-Z0-9][^:]{2,48}:$/.test(line) &&
        i + 1 < lines.length &&
        lines[i + 1].trim().length > 0
      ) {
        out.push({ kind: 'heading', text: line.slice(0, -1) });
        i += 1;
        continue;
      }

      if (/^[-*•]\s+/.test(line)) {
        const items: string[] = [];
        while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
          items.push(lines[i].trim().replace(/^[-*•]\s+/, ''));
          i += 1;
        }
        out.push({ kind: 'bullet', items });
        continue;
      }

      if (/^\d+[.)]\s+/.test(line)) {
        const items: Array<{ num: string; text: string }> = [];
        while (i < lines.length) {
          const m = lines[i].trim().match(/^(\d+)[.)]\s+(.+)$/);
          if (!m) break;
          items.push({ num: m[1], text: m[2] });
          i += 1;
        }
        out.push({ kind: 'numbered', items });
        continue;
      }

      // Collect contiguous paragraph lines until blank line or structural marker
      const paraLines: string[] = [];
      while (i < lines.length) {
        const cur = lines[i].trim();
        if (
          !cur ||
          cur.startsWith('```') ||
          /^#{1,4}\s+/.test(cur) ||
          /^[-*•]\s+/.test(cur) ||
          /^\d+[.)]\s+/.test(cur) ||
          /^[A-Z0-9][^:]{2,48}:$/.test(cur)
        ) {
          break;
        }
        paraLines.push(cur);
        i += 1;
      }
      const joined = paraLines.join(' ');
      // If a single block is a long multi-sentence wall of text, split neatly every 2 sentences
      if (joined.length > 260) {
        const sentences = joined.match(/[^.!?]+[.!?]+(?:\s+|$)/g);
        if (sentences && sentences.length >= 3) {
          for (let s = 0; s < sentences.length; s += 2) {
            const chunk = sentences.slice(s, s + 2).join(' ').trim();
            if (chunk) out.push({ kind: 'paragraph', text: chunk });
          }
          continue;
        }
      }
      if (joined) {
        out.push({ kind: 'paragraph', text: joined });
      }
    }

    return out;
  }, [content]);

  return (
    <div className="space-y-2.5 text-[13px] text-slate-200 leading-relaxed">
      {blocks.map((block, idx) => {
        if (block.kind === 'heading') {
          return (
            <div
              key={idx}
              className="pt-1 text-[11px] font-mono font-semibold uppercase tracking-wider text-sky-400"
            >
              {block.text}
            </div>
          );
        }
        if (block.kind === 'bullet') {
          return (
            <ul key={idx} className="space-y-1.5 pl-1">
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx} className="flex items-start gap-2">
                  <span className="mt-2 w-1.5 h-1.5 rounded-full bg-sky-400 shrink-0" />
                  <span className="min-w-0">{renderInlineRichText(item, `${idx}-${itemIdx}`)}</span>
                </li>
              ))}
            </ul>
          );
        }
        if (block.kind === 'numbered') {
          return (
            <ol key={idx} className="space-y-1.5 pl-0.5">
              {block.items.map((item, itemIdx) => (
                <li key={itemIdx} className="flex items-start gap-2">
                  <span className="font-mono text-[11px] text-sky-400 mt-0.5 w-4 shrink-0 tabular-nums">
                    {item.num}.
                  </span>
                  <span className="min-w-0">{renderInlineRichText(item.text, `${idx}-${itemIdx}`)}</span>
                </li>
              ))}
            </ol>
          );
        }
        if (block.kind === 'code') {
          return (
            <pre
              key={idx}
              className="p-2.5 rounded-lg bg-[#080C12] border border-slate-800 overflow-x-auto text-[11px] font-mono leading-relaxed text-sky-100"
            >
              <code>{block.code}</code>
            </pre>
          );
        }
        return <p key={idx}>{renderInlineRichText(block.text, `p-${idx}`)}</p>;
      })}
    </div>
  );
};

export const JarvisConsole: React.FC<JarvisConsoleProps> = ({
  open,
  loading,
  messages,
  activePage,
  profileDomainFilter,
  selectedSkillTitle,
  profile,
  skills,
  todayQuests,
  activeProject,
  pendingQuestsCount,
  onToggleOpen,
  onSendMessage,
  onExecuteActions,
  onAddMessage,
  onClearHistory,
  onAnalyzeNow,
}) => {
  const [input, setInput] = useState('');
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [listening, setListening] = useState(false);
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  // Real-time Gemini Live Voice Call state
  const [liveState, setLiveState] = useState<LiveVoiceState>('disconnected');
  const [liveMuted, setLiveMuted] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveUserTranscript, setLiveUserTranscript] = useState('');
  const [liveAssistantTranscript, setLiveAssistantTranscript] = useState('');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const recognitionRef = useRef<SpeechRecognitionInstanceLike | null>(null);
  const lastSpokenIdRef = useRef<string | null>(null);

  const liveClientRef = useRef<LiveJarvisClient | null>(null);
  const onExecuteActionsRef = useRef(onExecuteActions);
  const onAddMessageRef = useRef(onAddMessage);
  const pendingVoiceActionsRef = useRef<string[]>([]);

  useEffect(() => {
    onExecuteActionsRef.current = onExecuteActions;
  }, [onExecuteActions]);

  useEffect(() => {
    onAddMessageRef.current = onAddMessage;
  }, [onAddMessage]);

  useEffect(() => {
    return () => {
      liveClientRef.current?.disconnect();
      liveClientRef.current = null;
    };
  }, []);

  const isLiveCallActive =
    liveState === 'connecting' ||
    liveState === 'listening' ||
    liveState === 'thinking' ||
    liveState === 'speaking';

  const handleToggleLiveCall = async () => {
    if (isLiveCallActive) {
      liveClientRef.current?.disconnect();
      liveClientRef.current = null;
      setLiveMuted(false);
      setLiveUserTranscript('');
      setLiveAssistantTranscript('');
      return;
    }

    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    setLiveError(null);
    setLiveMuted(false);
    setLiveUserTranscript('');
    setLiveAssistantTranscript('');
    pendingVoiceActionsRef.current = [];
    onToggleOpen(true);

    const client = new LiveJarvisClient({
      onStateChange: (next) => {
        setLiveState(next);
        if (next === 'disconnected') {
          setLiveUserTranscript('');
          setLiveAssistantTranscript('');
        }
      },
      onInputTranscript: (text) => setLiveUserTranscript(text),
      onOutputTranscript: (text) => setLiveAssistantTranscript(text),
      onActions: (actions) => {
        const executed = onExecuteActionsRef.current(actions);
        if (executed.length > 0) {
          pendingVoiceActionsRef.current = Array.from(
            new Set([...pendingVoiceActionsRef.current, ...executed])
          );
        }
      },
      onTurnComplete: ({ userText, assistantText }) => {
        const now = Date.now();
        if (userText) {
          onAddMessageRef.current({
            id: `vu-${now}`,
            role: 'user',
            content: userText,
            timestamp: new Date().toISOString(),
          });
        }
        const actionsForTurn = [...pendingVoiceActionsRef.current];
        pendingVoiceActionsRef.current = [];
        if (assistantText || actionsForTurn.length > 0) {
          onAddMessageRef.current({
            id: `va-${now + 1}`,
            role: 'assistant',
            headline: 'JARVIS Live Voice',
            interactiveMode: 'mentor',
            content: assistantText || 'Executed voice workspace command.',
            executedActions: actionsForTurn.length > 0 ? actionsForTurn : undefined,
            timestamp: new Date().toISOString(),
          });
        }
      },
      onError: (msg) => {
        setLiveError(msg);
      },
    });

    liveClientRef.current = client;
    const payload = buildLiveVoiceContext({
      profile,
      activeProject,
      skills,
      todayQuests,
      currentScreen: {
        activePage,
        profileDomainFilter,
        selectedSkillTitle,
      },
    });
    await client.connect(payload);
  };

  const handleToggleLiveMute = () => {
    const next = !liveMuted;
    setLiveMuted(next);
    liveClientRef.current?.setMuted(next);
  };

  const handleCopySnippet = async (messageId: string, code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedMessageId(messageId);
      window.setTimeout(() => {
        setCopiedMessageId((prev) => (prev === messageId ? null : prev));
      }, 1800);
    } catch {
      // Ignore clipboard permission errors cleanly
    }
  };

  const supportsTts =
    typeof window !== 'undefined' && 'speechSynthesis' in window;

  const speechCtor = useMemo<SpeechRecognitionCtor | null>(() => {
    if (typeof window === 'undefined') return null;
    const win = window as unknown as {
      SpeechRecognition?: SpeechRecognitionCtor;
      webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return win.SpeechRecognition || win.webkitSpeechRecognition || null;
  }, []);

  // Scroll to bottom when new messages arrive
  useEffect(() => {
    if (!open) return;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, loading, open]);

  // Focus input when opened
  useEffect(() => {
    if (open) {
      const id = window.setTimeout(() => inputRef.current?.focus(), 80);
      return () => window.clearTimeout(id);
    }
  }, [open]);

  // Keyboard shortcut Ctrl+J / Cmd+J to toggle JARVIS
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        onToggleOpen(!open);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onToggleOpen]);

  // Optional TTS readout for newest assistant response when voice mode is toggled on
  useEffect(() => {
    if (!voiceEnabled || !supportsTts || messages.length === 0) return;
    const latest = messages[messages.length - 1];
    if (latest.role !== 'assistant' || latest.id === lastSpokenIdRef.current) return;
    lastSpokenIdRef.current = latest.id;

    try {
      window.speechSynthesis.cancel();
      const firstSentence = latest.content.split('\n')[0] || latest.headline || '';
      if (firstSentence.trim()) {
        const utterance = new SpeechSynthesisUtterance(firstSentence.slice(0, 320));
        utterance.rate = 1.04;
        window.speechSynthesis.speak(utterance);
      }
    } catch {
      // Ignore TTS failures cleanly
    }
  }, [messages, voiceEnabled, supportsTts]);

  const handleToggleVoiceOutput = () => {
    const next = !voiceEnabled;
    setVoiceEnabled(next);
    if (!next && supportsTts) {
      window.speechSynthesis.cancel();
    }
  };

  const handleToggleMic = () => {
    if (!speechCtor) return;
    if (listening && recognitionRef.current) {
      recognitionRef.current.stop();
      setListening(false);
      return;
    }

    try {
      const rec = new speechCtor();
      rec.lang = 'en-US';
      rec.interimResults = false;
      rec.maxAlternatives = 1;
      rec.onresult = (event) => {
        const transcript = event.results?.[0]?.[0]?.transcript?.trim();
        if (transcript) {
          setInput((prev) => (prev ? `${prev} ${transcript}` : transcript));
        }
      };
      rec.onerror = () => setListening(false);
      rec.onend = () => setListening(false);
      recognitionRef.current = rec;
      setListening(true);
      rec.start();
    } catch {
      setListening(false);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || loading) return;
    setInput('');
    if (isLiveCallActive && liveClientRef.current) {
      onAddMessage({
        id: `vu-${Date.now()}`,
        role: 'user',
        content: trimmed,
        timestamp: new Date().toISOString(),
      });
      liveClientRef.current.sendText(trimmed);
      return;
    }
    onSendMessage(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const screenLabel =
    activePage === 'quests'
      ? `Quests (${pendingQuestsCount} pending)`
      : activePage === 'roadmaps'
      ? `Roadmaps (${profileDomainFilter})`
      : activePage === 'upload'
      ? 'Upload Task'
      : selectedSkillTitle
      ? `Profile · Brief: ${selectedSkillTitle.slice(0, 28)}`
      : `Profile (${profileDomainFilter})`;

  const quickStarters = useMemo(() => {
    if (activeProject) {
      return [
        'Design my 5-domain Top 1% roadmaps',
        `Analyze "${activeProject.projectName.slice(0, 34)}" and tell me what to do first`,
        `Mark "${activeProject.projectName.slice(0, 34)}" job done and resume normal path`,
        'Quiz me on Top 1% production failure modes',
      ];
    }
    return [
      'Design roadmaps for all 5 domains (Angular, FastAPI, DevOps, AWS, GCP)',
      'Structure my 5-domain syllabus for Top 1% mastery',
      'Audit my weakest domain across Angular, FastAPI, DevOps, AWS, GCP',
      'Analyze my daily quests & tell me what to do next',
    ];
  }, [activeProject]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => onToggleOpen(true)}
        className="fixed bottom-5 right-5 z-50 inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-[#121824] hover:bg-slate-800 border border-sky-500/50 text-slate-100 text-xs font-semibold shadow-lg shadow-black/40 transition-colors cursor-pointer"
        aria-label="Open JARVIS Mentor"
      >
        <Bot className="w-4 h-4 text-sky-400 shrink-0" />
        <span>JARVIS Mentor</span>
        <span className="font-mono text-[11px] text-slate-400 border-l border-slate-700 pl-2">
          ⌘J
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="JARVIS Interactive Command Mentor"
      className="fixed top-14 right-0 bottom-0 z-50 w-full sm:w-[440px] bg-[#121824] border-l border-slate-800 flex flex-col shadow-2xl shadow-black/60"
    >
      {/* Header */}
      <div className="px-4 py-3.5 border-b border-slate-800/90 flex items-center justify-between gap-2 bg-[#0F1520]">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-sky-400 shrink-0" />
            <h2 className="font-display text-sm font-semibold text-slate-50 truncate">
              JARVIS Command Mentor
            </h2>
          </div>
          <div className="text-[11px] font-mono text-slate-400 truncate mt-0.5">
            Screen: {screenLabel}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => void handleToggleLiveCall()}
            title={isLiveCallActive ? 'End two-way voice call' : 'Start live two-way voice call'}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
              isLiveCallActive
                ? 'bg-red-500/20 hover:bg-red-500/30 border-red-500/50 text-red-200'
                : 'bg-emerald-500/15 hover:bg-emerald-500/25 border-emerald-500/40 text-emerald-200'
            }`}
          >
            {isLiveCallActive ? (
              <>
                <PhoneOff className="w-3.5 h-3.5" />
                <span>End Voice</span>
              </>
            ) : (
              <>
                <Phone className="w-3.5 h-3.5" />
                <span>Voice Call</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={onAnalyzeNow}
            disabled={loading}
            title="Analyze current project & quests and switch screen"
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/40 text-sky-200 text-xs font-medium disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Compass className="w-3.5 h-3.5" />
            <span>Analyze</span>
          </button>

          {supportsTts && !isLiveCallActive && (
            <button
              type="button"
              onClick={handleToggleVoiceOutput}
              title={voiceEnabled ? 'Mute voice readout' : 'Enable voice readout'}
              aria-label={voiceEnabled ? 'Mute voice readout' : 'Enable voice readout'}
              className={`p-1.5 rounded-lg border transition-colors cursor-pointer ${
                voiceEnabled
                  ? 'bg-sky-500/15 border-sky-500/40 text-sky-300'
                  : 'bg-[#0B0F17] border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {voiceEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
            </button>
          )}

          {onClearHistory && messages.length > 0 && (
            <button
              type="button"
              onClick={onClearHistory}
              disabled={loading}
              title="Clear JARVIS thread"
              aria-label="Clear JARVIS thread"
              className="p-1.5 rounded-lg text-slate-400 hover:text-red-300 hover:bg-slate-800 disabled:opacity-50 transition-colors cursor-pointer"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}

          <button
            type="button"
            onClick={() => onToggleOpen(false)}
            aria-label="Close JARVIS console"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Live Two-Way Voice Session Strip */}
      {(isLiveCallActive || liveError) && (
        <div className="px-4 py-2.5 border-b border-slate-800 bg-[#0B121D] space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span
                className={`w-2 h-2 rounded-full shrink-0 ${
                  liveError
                    ? 'bg-red-400'
                    : liveState === 'speaking'
                    ? 'bg-sky-400 animate-pulse'
                    : liveState === 'thinking'
                    ? 'bg-amber-400 animate-pulse'
                    : liveState === 'connecting'
                    ? 'bg-slate-400 animate-pulse'
                    : 'bg-emerald-400 animate-pulse'
                }`}
              />
              <span className="text-[11px] font-mono uppercase tracking-wider text-slate-200 truncate">
                {liveError
                  ? 'Voice Connection Error'
                  : liveState === 'connecting'
                  ? 'Connecting Live Voice...'
                  : liveState === 'thinking'
                  ? 'JARVIS Reasoning...'
                  : liveState === 'speaking'
                  ? 'JARVIS Speaking (Interrupt Anytime)'
                  : liveMuted
                  ? 'Mic Muted'
                  : 'Listening — Speak Anytime'}
              </span>
            </div>

            {isLiveCallActive && (
              <button
                type="button"
                onClick={handleToggleLiveMute}
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md border text-[11px] font-mono transition-colors cursor-pointer shrink-0 ${
                  liveMuted
                    ? 'bg-amber-500/15 border-amber-500/40 text-amber-200'
                    : 'bg-[#121824] border-slate-700 text-slate-300 hover:text-white'
                }`}
              >
                {liveMuted ? <MicOff className="w-3 h-3" /> : <Mic className="w-3 h-3 text-emerald-400" />}
                <span>{liveMuted ? 'Muted' : 'Mic On'}</span>
              </button>
            )}
          </div>

          {liveError && (
            <div className="text-[11px] text-red-300 leading-snug">{liveError}</div>
          )}

          {(liveUserTranscript || liveAssistantTranscript) && (
            <div className="space-y-1 text-[11px] leading-snug bg-[#080C12] border border-slate-800/80 rounded-lg p-2">
              {liveUserTranscript && (
                <div className="text-slate-300">
                  <span className="font-mono text-sky-400">You: </span>
                  {liveUserTranscript}
                </div>
              )}
              {liveAssistantTranscript && (
                <div className="text-slate-100">
                  <span className="font-mono text-emerald-400">JARVIS: </span>
                  {liveAssistantTranscript}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Interactive Command Toolbar */}
      <div className="px-4 py-2 border-b border-slate-800/80 bg-[#0B0F17] flex items-center gap-1.5 overflow-x-auto">
        <button
          type="button"
          disabled={loading}
          onClick={() => onSendMessage('Walk me through quest 1 step by step with code')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#121824] hover:bg-slate-800 border border-slate-800 hover:border-sky-500/40 text-[11px] font-medium text-slate-200 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <ListChecks className="w-3 h-3 text-sky-400" />
          <span>Walkthrough #1</span>
        </button>

        <button
          type="button"
          disabled={loading}
          onClick={() => onSendMessage('Quiz me on my active topic')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#121824] hover:bg-slate-800 border border-slate-800 hover:border-sky-500/40 text-[11px] font-medium text-slate-200 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <HelpCircle className="w-3 h-3 text-amber-400" />
          <span>Quiz Me</span>
        </button>

        <button
          type="button"
          disabled={loading}
          onClick={() => onSendMessage('Structure my 5-domain syllabus for Top 1% mastery')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#121824] hover:bg-slate-800 border border-slate-800 hover:border-sky-500/40 text-[11px] font-medium text-sky-200 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <Layers className="w-3 h-3 text-sky-400" />
          <span>Structure Syllabus</span>
        </button>

        {pendingQuestsCount > 0 && (
          <button
            type="button"
            disabled={loading}
            onClick={() => onSendMessage('Complete quest 1 and move to the next quest')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[#121824] hover:bg-slate-800 border border-slate-800 hover:border-emerald-500/40 text-[11px] font-medium text-emerald-300 disabled:opacity-50 transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <CheckSquare className="w-3 h-3 text-emerald-400" />
            <span>Complete #1</span>
          </button>
        )}
      </div>

      {/* Messages Viewport */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-[#0B0F17] border border-slate-800/90 space-y-2">
              <div className="flex items-center gap-2 text-xs font-mono text-sky-400">
                <Sparkles className="w-3.5 h-3.5" />
                <span>TOP 1% SYLLABUS ARCHITECT &amp; MENTOR</span>
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                My primary goal is driving you to <strong className="text-slate-100">Top 1% mastery</strong>{' '}
                across Angular, FastAPI, DevOps, AWS, and GCP. I audit your domain gaps, structure
                and upgrade your syllabus, teach Staff-level internals, and drill real failure modes.
              </p>
            </div>

            <div className="space-y-2">
              <div className="text-[11px] font-mono uppercase tracking-wider text-slate-500">
                Quick Commands
              </div>
              <div className="grid grid-cols-1 gap-2">
                {quickStarters.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    disabled={loading}
                    onClick={() => onSendMessage(prompt)}
                    className="text-left px-3.5 py-2.5 rounded-lg bg-[#0B0F17] hover:bg-slate-800/70 border border-slate-800 hover:border-sky-500/40 text-xs text-slate-200 transition-colors cursor-pointer"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              {msg.role === 'user' ? (
                <div className="max-w-[88%] px-3.5 py-2.5 rounded-xl bg-sky-500/15 border border-sky-500/35 text-xs text-slate-100 leading-relaxed whitespace-pre-wrap">
                  {msg.content}
                </div>
              ) : (
                <div className="w-full p-4 rounded-xl bg-[#0B0F17] border border-slate-800 space-y-3">
                  {(msg.headline || (msg.interactiveMode && msg.interactiveMode !== 'mentor')) && (
                    <div className="flex items-center justify-between gap-2">
                      {msg.headline && (
                        <div className="text-[11px] font-mono text-sky-400 uppercase tracking-wider truncate">
                          {msg.headline}
                        </div>
                      )}
                      {msg.interactiveMode === 'quiz' && (
                        <span className="text-[10px] font-mono uppercase tracking-wider text-amber-300 shrink-0">
                          QUIZ CHALLENGE
                        </span>
                      )}
                      {msg.interactiveMode === 'walkthrough' && (
                        <span className="text-[10px] font-mono uppercase tracking-wider text-sky-300 shrink-0">
                          WALKTHROUGH
                        </span>
                      )}
                    </div>
                  )}

                  {msg.executedActions && msg.executedActions.length > 0 && (
                    <div className="p-2.5 rounded-lg bg-[#121824] border border-emerald-500/30 space-y-1">
                      {msg.executedActions.map((act, idx) => (
                        <div key={idx} className="text-[11px] font-mono text-emerald-300">
                          → {act}
                        </div>
                      ))}
                    </div>
                  )}

                  <FormattedJarvisContent content={msg.content} />

                  {msg.codeSnippet && (
                    <div className="rounded-lg bg-[#080C12] border border-slate-800 overflow-hidden">
                      <div className="px-3 py-1.5 border-b border-slate-800/80 flex items-center justify-between bg-[#0D131D]">
                        <span className="text-[10px] font-mono uppercase tracking-wider text-slate-400">
                          Production Code Reference
                        </span>
                        <button
                          type="button"
                          onClick={() => void handleCopySnippet(msg.id, msg.codeSnippet || '')}
                          className="inline-flex items-center gap-1 text-[11px] font-mono text-slate-300 hover:text-sky-300 transition-colors cursor-pointer"
                        >
                          {copiedMessageId === msg.id ? (
                            <>
                              <Check className="w-3 h-3 text-emerald-400" />
                              <span className="text-emerald-400">Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-3 h-3" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                      <pre className="p-3 overflow-x-auto text-[11px] font-mono leading-relaxed text-sky-100">
                        <code>{msg.codeSnippet}</code>
                      </pre>
                    </div>
                  )}

                  {msg.suggestedFollowUps && msg.suggestedFollowUps.length > 0 && (
                    <div className="pt-2 border-t border-slate-800/80 flex flex-wrap gap-1.5">
                      {msg.suggestedFollowUps.map((followUp) => (
                        <button
                          key={followUp}
                          type="button"
                          disabled={loading}
                          onClick={() => onSendMessage(followUp)}
                          className="px-2.5 py-1.5 rounded-md bg-[#121824] hover:bg-slate-800 border border-slate-700/80 hover:border-sky-500/40 text-[11px] text-slate-200 transition-colors cursor-pointer text-left"
                        >
                          {followUp}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}

        {loading && (
          <div className="p-3.5 rounded-xl bg-[#0B0F17] border border-slate-800 flex items-center gap-2.5 text-xs text-slate-300">
            <Loader2 className="w-4 h-4 text-sky-400 animate-spin shrink-0" />
            <span>JARVIS is analyzing your tasks &amp; workspace...</span>
          </div>
        )}
      </div>

      {/* Input Footer */}
      <form
        onSubmit={handleSubmit}
        className="p-3.5 border-t border-slate-800/90 bg-[#0F1520] space-y-2"
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a technical doubt, command a screen switch, or ask what to do next..."
            className="flex-1 resize-none px-3 py-2 rounded-lg bg-[#0B0F17] border border-slate-800 focus:border-sky-500 text-xs text-slate-100 placeholder-slate-500 focus:outline-none"
          />

          {speechCtor && (
            <button
              type="button"
              onClick={handleToggleMic}
              title={listening ? 'Stop voice input' : 'Speak command or doubt'}
              aria-label={listening ? 'Stop voice input' : 'Speak command or doubt'}
              className={`p-2.5 rounded-lg border transition-colors cursor-pointer shrink-0 ${
                listening
                  ? 'bg-red-500/20 border-red-500/50 text-red-300'
                  : 'bg-[#0B0F17] border-slate-800 text-slate-300 hover:text-white'
              }`}
            >
              {listening ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          )}

          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label="Send message to JARVIS"
            className="p-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 transition-colors cursor-pointer shrink-0"
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </form>
    </aside>
  );
};
