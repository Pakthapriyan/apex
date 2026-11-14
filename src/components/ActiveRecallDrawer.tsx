import React, { useMemo, useState } from 'react';
import {
  Brain,
  CheckCircle2,
  Eye,
  Loader2,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react';
import { DOMAINS } from '../data/seedCurriculum';
import { generateQuizCardsWithAi } from '../lib/aiClient';
import { createReviewCards, gradeReviewCard } from '../lib/firestoreService';
import type { Domain, ReviewCard } from '../types/learning';

interface ActiveRecallDrawerProps {
  open: boolean;
  userId: string;
  cards: ReviewCard[];
  defaultDomain?: Domain;
  jarvisOpen?: boolean;
  onClose: () => void;
  onNotify?: (message: string | null) => void;
}

export const ActiveRecallDrawer: React.FC<ActiveRecallDrawerProps> = ({
  open,
  userId,
  cards,
  defaultDomain = 'AWS',
  jarvisOpen = false,
  onClose,
  onNotify,
}) => {
  const [filterMode, setFilterMode] = useState<'due' | 'all'>('due');
  const [cardIndex, setCardIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const [grading, setGrading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genDomain, setGenDomain] = useState<Domain>(defaultDomain);
  const [error, setError] = useState<string | null>(null);

  const nowIso = new Date().toISOString();

  const dueCards = useMemo(
    () =>
      cards
        .filter((c) => !c.nextReviewAt || c.nextReviewAt <= nowIso)
        .sort((a, b) => (a.nextReviewAt || '').localeCompare(b.nextReviewAt || '')),
    [cards, nowIso]
  );

  const deck = filterMode === 'due' ? dueCards : cards;
  const safeIndex = deck.length > 0 ? Math.min(cardIndex, deck.length - 1) : 0;
  const currentCard = deck[safeIndex] || null;

  if (!open) return null;

  const handleGrade = async (quality: 1 | 3 | 4 | 5) => {
    if (!currentCard || grading) return;
    setGrading(true);
    setError(null);
    try {
      await gradeReviewCard(userId, currentCard, quality);
      setRevealed(false);
      if (filterMode === 'all') {
        setCardIndex((prev) => (prev + 1 < deck.length ? prev + 1 : 0));
      } else {
        setCardIndex(0);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to grade review card.');
    } finally {
      setGrading(false);
    }
  };

  const handleGenerateMore = async () => {
    if (generating) return;
    setGenerating(true);
    setError(null);
    try {
      const res = await generateQuizCardsWithAi({
        domain: genDomain,
        existingPrompts: cards.map((c) => c.prompt),
      });
      if (res.cards?.length > 0) {
        await createReviewCards(userId, res.cards);
        setFilterMode('due');
        setCardIndex(0);
        setRevealed(false);
        onNotify?.(`Added ${res.cards.length} Top 1% ${genDomain} recall cards to your deck.`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate flashcards.');
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div
      className={`fixed inset-0 z-40 flex justify-end ${
        jarvisOpen ? 'lg:justify-start lg:pr-[440px]' : ''
      }`}
    >
      <div className="fixed inset-0 bg-black/70" onClick={onClose} />
      <aside
        aria-label="SM-2 Active Recall Drill"
        className={`relative z-10 w-full max-w-xl bg-[#121824] border-slate-800 h-full overflow-y-auto flex flex-col ${
          jarvisOpen ? 'border-l lg:border-l-0 lg:border-r' : 'border-l'
        }`}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-800/90 bg-[#0F1520] flex items-center justify-between gap-3">
          <div className="space-y-0.5 min-w-0">
            <div className="flex items-center gap-2 text-xs font-mono text-sky-400">
              <Brain className="w-4 h-4 shrink-0" />
              <span>SM-2 SPACED REPETITION DRILL</span>
            </div>
            <h2 className="font-display text-base font-semibold text-slate-50 truncate">
              Active Recall Deck
            </h2>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close active recall drawer"
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6 space-y-5 flex-1">
          {error && (
            <div className="p-3 rounded-lg bg-red-950/40 border border-red-800/60 text-xs text-red-200">
              {error}
            </div>
          )}

          {/* Deck Filter & AI Card Generator */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#0B0F17] border border-slate-800">
              <button
                type="button"
                onClick={() => {
                  setFilterMode('due');
                  setCardIndex(0);
                  setRevealed(false);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                  filterMode === 'due'
                    ? 'bg-sky-500 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Due Now ({dueCards.length})
              </button>
              <button
                type="button"
                onClick={() => {
                  setFilterMode('all');
                  setCardIndex(0);
                  setRevealed(false);
                }}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap tabular-nums ${
                  filterMode === 'all'
                    ? 'bg-sky-500 text-slate-950 font-semibold'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                All Cards ({cards.length})
              </button>
            </div>

            <div className="flex items-center gap-2">
              <select
                value={genDomain}
                onChange={(e) => setGenDomain(e.target.value as Domain)}
                aria-label="Domain for new flashcards"
                className="px-2.5 py-1.5 rounded-lg bg-[#0B0F17] border border-slate-800 text-xs text-slate-200 focus:outline-none focus:border-sky-500"
              >
                {DOMAINS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={generating}
                onClick={() => void handleGenerateMore()}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 disabled:opacity-50 text-xs font-semibold text-sky-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {generating ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Generating...</span>
                  </>
                ) : (
                  <>
                    <Plus className="w-3.5 h-3.5" />
                    <span>Add 5 AI Cards</span>
                  </>
                )}
              </button>
            </div>
          </div>

          {/* Active Card Viewport */}
          {!currentCard ? (
            <div className="p-8 rounded-xl bg-[#0B0F17] border border-slate-800/90 text-center space-y-3">
              <CheckCircle2 className="w-7 h-7 text-emerald-400 mx-auto" />
              <div className="text-sm font-semibold text-slate-100">
                {filterMode === 'due'
                  ? 'All Due Recall Cards Cleared'
                  : 'No Recall Cards Yet'}
              </div>
              <p className="text-xs text-slate-400 max-w-sm mx-auto leading-relaxed">
                {filterMode === 'due'
                  ? `You have zero due SM-2 cards right now (${cards.length} total in deck). Switch to All Cards to practice early or generate 5 fresh cards above.`
                  : 'Generate 5 AI flashcards for any domain to start spaced repetition practice.'}
              </p>
              {cards.length > 0 && filterMode === 'due' && (
                <button
                  type="button"
                  onClick={() => {
                    setFilterMode('all');
                    setCardIndex(0);
                    setRevealed(false);
                  }}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-slate-700 bg-[#121824] hover:bg-slate-800 text-xs font-medium text-slate-200 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Browse All {cards.length} Cards</span>
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-xl bg-[#0B0F17] border border-slate-800/90 overflow-hidden">
              <div className="px-5 py-3 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
                <span className="text-sky-400">
                  {currentCard.domain} · {currentCard.skillTitle}
                </span>
                <span className="text-slate-400">
                  Card {safeIndex + 1} / {deck.length} · Reps {currentCard.repetitions} · Interval{' '}
                  {currentCard.intervalDays}d
                </span>
              </div>

              <div className="p-5 space-y-4">
                <div className="space-y-1.5">
                  <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
                    Question / Production Scenario
                  </div>
                  <p className="text-sm font-medium text-slate-100 leading-relaxed whitespace-pre-wrap">
                    {currentCard.prompt}
                  </p>
                </div>

                {!revealed ? (
                  <button
                    type="button"
                    onClick={() => setRevealed(true)}
                    className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    <span>Reveal Top 1% Answer</span>
                  </button>
                ) : (
                  <div className="space-y-4 pt-3 border-t border-slate-800/80">
                    <div className="space-y-1.5">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-emerald-400">
                        Reference Answer
                      </div>
                      <p className="text-xs sm:text-sm text-slate-100 leading-relaxed whitespace-pre-wrap">
                        {currentCard.answer}
                      </p>
                    </div>

                    {currentCard.explanation && (
                      <div className="p-3.5 rounded-lg bg-[#121824] border border-slate-800/80 space-y-1">
                        <div className="text-[11px] font-mono uppercase tracking-wider text-sky-400">
                          Why It Matters in Production
                        </div>
                        <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap">
                          {currentCard.explanation}
                        </p>
                      </div>
                    )}

                    <div className="space-y-2 pt-2">
                      <div className="text-[11px] font-mono text-slate-400">
                        Grade recall confidence (updates SM-2 schedule):
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <button
                          type="button"
                          disabled={grading}
                          onClick={() => void handleGrade(1)}
                          className="px-3 py-2 rounded-lg border border-red-500/40 bg-red-500/10 hover:bg-red-500/20 text-xs font-semibold text-red-200 cursor-pointer whitespace-nowrap"
                        >
                          Again (1d)
                        </button>
                        <button
                          type="button"
                          disabled={grading}
                          onClick={() => void handleGrade(3)}
                          className="px-3 py-2 rounded-lg border border-amber-500/40 bg-amber-500/10 hover:bg-amber-500/20 text-xs font-semibold text-amber-200 cursor-pointer whitespace-nowrap"
                        >
                          Hard
                        </button>
                        <button
                          type="button"
                          disabled={grading}
                          onClick={() => void handleGrade(4)}
                          className="px-3 py-2 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-xs font-semibold text-sky-200 cursor-pointer whitespace-nowrap"
                        >
                          Good
                        </button>
                        <button
                          type="button"
                          disabled={grading}
                          onClick={() => void handleGrade(5)}
                          className="px-3 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-xs font-semibold text-emerald-200 cursor-pointer whitespace-nowrap"
                        >
                          Easy
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
};
