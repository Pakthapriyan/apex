import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Bot,
  Briefcase,
  CheckCircle2,
  Circle,
  Compass,
  Flag,
  GitBranch,
  Layers,
  ListChecks,
  ListTree,
  Loader2,
  Map,
  Sparkles,
  Target,
  X,
} from 'lucide-react';
import { computeDomainLevelStats } from '../data/milestones';
import { DOMAINS } from '../data/seedCurriculum';
import { generateDailyQuestsWithSystemAi, mapWorkLogWithAi } from '../lib/aiClient';
import {
  getTodayDayKey,
  getTodayIsoDate,
  markJobTaskDoneAndResumePath,
  saveGeneratedDailyQuests,
  toggleRoadmapStepCompletion,
  updateSkillMastery,
} from '../lib/firestoreService';
import type {
  DailyQuest,
  Domain,
  DomainRoadmap,
  DomainRoadmapStep,
  ProjectMission,
  SimplePage,
  SkillNode,
  SkillTier,
  UserProfile,
  WorkLog,
} from '../types/learning';
import type { CelebrationEvent } from './CelebrationOverlay';

interface RoadmapsPageProps {
  profile: UserProfile;
  skills: SkillNode[];
  workLogs: WorkLog[];
  missions: ProjectMission[];
  quests: DailyQuest[];
  roadmaps: Partial<Record<Domain, DomainRoadmap>>;
  dueCardsCount?: number;
  selectedDomain: Domain | 'All';
  onSelectDomain: (domain: Domain | 'All') => void;
  designingDomain: Domain | 'All' | null;
  designingProgress?: { current: number; total: number; domain: Domain } | null;
  onDesignRoadmap: (domain: Domain, focusGoal?: string) => Promise<void> | void;
  onDesignAllRoadmaps: (opts?: {
    onlyMissing?: boolean;
    focusGoal?: string;
  }) => Promise<void> | void;
  onCelebrate: (event: CelebrationEvent) => void;
  onNotify?: (message: string | null) => void;
  onNavigate: (page: SimplePage, domainFilter?: Domain) => void;
  onAskJarvis?: (prompt: string) => void;
}

interface UnifiedStageStep {
  uidKey: string;
  step: DomainRoadmapStep;
  sourceDomain: Domain;
  sourceType: 'roadmap' | 'skill';
  sourceRoadmap?: DomainRoadmap;
  sourceSkill?: SkillNode;
}

interface UnifiedStage {
  stageKey: string;
  stageNumber: number;
  title: string;
  domain: Domain;
  targetTier: SkillTier;
  milestoneGoal: string;
  sourceType: 'roadmap' | 'skill';
  steps: UnifiedStageStep[];
}

interface FlattenedRoadmapStep {
  uidKey: string;
  step: DomainRoadmapStep;
  stage: UnifiedStage;
  sourceDomain: Domain;
  sourceType: 'roadmap' | 'skill';
  sourceRoadmap?: DomainRoadmap;
  sourceSkill?: SkillNode;
  stepCode: string;
  globalIndex: number;
}

const DOMAIN_PIPELINE_META: Record<Domain, { order: number; phaseLabel: string }> = {
  Angular: { order: 1, phaseLabel: 'Client Reactivity & SSR Edge' },
  FastAPI: { order: 2, phaseLabel: 'Async API Core & Auth Boundaries' },
  DevOps: { order: 3, phaseLabel: 'Containers, IaC & GitOps Delivery' },
  AWS: { order: 4, phaseLabel: 'Primary Cloud Production (EKS & IAM)' },
  GCP: { order: 5, phaseLabel: 'Multi-Cloud Mesh & Data Scale' },
};

const TIER_SEQUENCE: SkillTier[] = ['Foundational', 'Senior', 'Top 1%'];

function splitReadableBlocks(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export const RoadmapsPage: React.FC<RoadmapsPageProps> = ({
  profile,
  skills,
  workLogs,
  missions,
  quests,
  roadmaps,
  dueCardsCount = 0,
  selectedDomain,
  onSelectDomain,
  designingDomain,
  designingProgress = null,
  onDesignRoadmap,
  onDesignAllRoadmaps,
  onCelebrate,
  onNotify,
  onNavigate,
  onAskJarvis,
}) => {
  const todayKey = getTodayIsoDate();
  const todaySlot = profile.rotationMap[getTodayDayKey()];
  const inspectorRef = useRef<HTMLElement | null>(null);
  const inspectorBodyRef = useRef<HTMLDivElement | null>(null);
  const mobileInspectorBodyRef = useRef<HTMLDivElement | null>(null);
  const graphRef = useRef<HTMLElement | null>(null);

  const activeProject = useMemo(
    () => missions.find((m) => m.status === 'active') || null,
    [missions]
  );

  const todayQuests = useMemo(
    () => quests.filter((q) => q.dateKey === todayKey),
    [quests, todayKey]
  );

  const domainStatsList = useMemo(
    () =>
      DOMAINS.map((domain) =>
        computeDomainLevelStats({
          domain,
          skills,
          quests,
          missions,
          workLogs,
          roadmap: roadmaps[domain] || null,
        })
      ),
    [skills, quests, missions, workLogs, roadmaps]
  );

  const selectedStats = useMemo(
    () =>
      domainStatsList.find((s) => s.domain === selectedDomain) || domainStatsList[0],
    [domainStatsList, selectedDomain]
  );

  const isAllMode = selectedDomain === 'All';
  const currentRoadmap = isAllMode ? null : roadmaps[selectedDomain] || null;
  const missingRoadmapDomains = useMemo(
    () => DOMAINS.filter((d) => !roadmaps[d]),
    [roadmaps]
  );

  const [viewMode, setViewMode] = useState<'graph' | 'list'>('graph');
  const [sequenceMode, setSequenceMode] = useState<'stack' | 'tier'>('stack');
  const [stepFilter, setStepFilter] = useState<'all' | 'pending' | 'done'>('all');
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);
  const [mobileInspectorOpen, setMobileInspectorOpen] = useState(false);
  const [focusGoalInput, setFocusGoalInput] = useState('');
  const [togglingStepId, setTogglingStepId] = useState<string | null>(null);
  const [showJobForm, setShowJobForm] = useState(false);
  const [jobTitle, setJobTitle] = useState('');
  const [jobDomain, setJobDomain] = useState<Domain>(
    selectedDomain === 'All' ? 'AWS' : selectedDomain
  );
  const [jobSummary, setJobSummary] = useState('');
  const [jobMinutes, setJobMinutes] = useState(60);
  const [alsoClearActiveOverride, setAlsoClearActiveOverride] = useState(true);
  const [submittingJob, setSubmittingJob] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unifiedMasterStats = useMemo(() => {
    const totalLevels = domainStatsList.reduce((sum, s) => sum + s.level, 0);
    const avgLevel = domainStatsList.length
      ? Math.max(1, Math.round(totalLevels / domainStatsList.length))
      : 1;
    const avgReadiness = domainStatsList.length
      ? Math.round(
          domainStatsList.reduce((sum, s) => sum + s.readinessScore, 0) /
            domainStatsList.length
        )
      : 0;
    const avgMastery = domainStatsList.length
      ? Math.round(
          domainStatsList.reduce((sum, s) => sum + s.avgMastery, 0) /
            domainStatsList.length
        )
      : 0;
    const top1NodesReady = domainStatsList.reduce((sum, s) => sum + s.top1NodesReady, 0);
    const top1NodesTotal = domainStatsList.reduce((sum, s) => sum + s.top1NodesTotal, 0);
    const completedJobsCount = domainStatsList.reduce(
      (sum, s) => sum + s.completedJobsCount,
      0
    );
    const totalDomainXp = domainStatsList.reduce((sum, s) => sum + s.domainXp, 0);
    const designedCount = DOMAINS.filter((d) => Boolean(roadmaps[d])).length;
    return {
      avgLevel,
      avgReadiness,
      avgMastery,
      top1NodesReady,
      top1NodesTotal,
      completedJobsCount,
      totalDomainXp,
      designedCount,
    };
  }, [domainStatsList, roadmaps]);

  const activeStages = useMemo<UnifiedStage[]>(() => {
    if (!isAllMode) {
      if (!currentRoadmap) return [];
      return currentRoadmap.stages.map((stage) => ({
        stageKey: `${selectedDomain}-s${stage.stageNumber}`,
        stageNumber: stage.stageNumber,
        title: stage.title,
        domain: selectedDomain,
        targetTier: stage.targetTier,
        milestoneGoal: stage.milestoneGoal,
        sourceType: 'roadmap',
        steps: stage.steps.map((step) => ({
          uidKey: step.id,
          step,
          sourceDomain: selectedDomain,
          sourceType: 'roadmap',
          sourceRoadmap: currentRoadmap,
        })),
      }));
    }

    const perDomainStages: UnifiedStage[] = [];
    for (const domain of DOMAINS) {
      const rm = roadmaps[domain];
      if (rm && rm.stages.length > 0) {
        rm.stages.forEach((stage) => {
          perDomainStages.push({
            stageKey: `${domain}-s${stage.stageNumber}`,
            stageNumber: stage.stageNumber,
            title: stage.title,
            domain,
            targetTier: stage.targetTier,
            milestoneGoal: stage.milestoneGoal,
            sourceType: 'roadmap',
            steps: stage.steps.map((step) => ({
              uidKey: `${domain}::${step.id}`,
              step,
              sourceDomain: domain,
              sourceType: 'roadmap',
              sourceRoadmap: rm,
            })),
          });
        });
      } else {
        const domSkills = skills.filter((s) => s.domain === domain);
        for (const tier of TIER_SEQUENCE) {
          const tierSkills = domSkills.filter((s) => s.tier === tier);
          if (tierSkills.length === 0) continue;
          perDomainStages.push({
            stageKey: `${domain}-seed-${tier}`,
            stageNumber: TIER_SEQUENCE.indexOf(tier) + 1,
            title: `${domain} ${tier} Track`,
            domain,
            targetTier: tier,
            milestoneGoal: `${DOMAIN_PIPELINE_META[domain].phaseLabel} (${tier} competencies)`,
            sourceType: 'skill',
            steps: tierSkills.map((sk) => ({
              uidKey: `${domain}::skill::${sk.id}`,
              sourceDomain: domain,
              sourceType: 'skill',
              sourceSkill: sk,
              step: {
                id: sk.id,
                title: sk.title,
                skillTitle: sk.title,
                description: sk.description,
                detailedGuide: sk.studyBrief,
                deliverables: sk.labPrompt ? [sk.labPrompt] : [],
                labObjective: sk.labPrompt,
                completed: sk.mastery >= 80,
                completedAt: sk.lastPracticedAt || undefined,
              },
            })),
          });
        }
      }
    }

    const ordered =
      sequenceMode === 'tier'
        ? [...perDomainStages].sort((a, b) => {
            const tierDiff =
              TIER_SEQUENCE.indexOf(a.targetTier) - TIER_SEQUENCE.indexOf(b.targetTier);
            if (tierDiff !== 0) return tierDiff;
            const domDiff =
              DOMAIN_PIPELINE_META[a.domain].order - DOMAIN_PIPELINE_META[b.domain].order;
            if (domDiff !== 0) return domDiff;
            return a.stageNumber - b.stageNumber;
          })
        : perDomainStages;

    return ordered.map((st, idx) => ({
      ...st,
      stageNumber: idx + 1,
    }));
  }, [isAllMode, currentRoadmap, selectedDomain, roadmaps, skills, sequenceMode]);

  const flattenedSteps = useMemo<FlattenedRoadmapStep[]>(() => {
    const items: FlattenedRoadmapStep[] = [];
    activeStages.forEach((stage) => {
      stage.steps.forEach((entry, idx) => {
        items.push({
          uidKey: entry.uidKey,
          step: entry.step,
          stage,
          sourceDomain: entry.sourceDomain,
          sourceType: entry.sourceType,
          sourceRoadmap: entry.sourceRoadmap,
          sourceSkill: entry.sourceSkill,
          stepCode: `${stage.stageNumber}.${idx + 1}`,
          globalIndex: items.length,
        });
      });
    });
    return items;
  }, [activeStages]);

  const nextFocusStepId = useMemo(
    () => flattenedSteps.find((item) => !item.step.completed)?.uidKey || null,
    [flattenedSteps]
  );

  const domainSkills = useMemo(() => {
    const tierOrder: Record<string, number> = { Foundational: 0, Senior: 1, 'Top 1%': 2 };
    const pool = isAllMode ? skills : skills.filter((s) => s.domain === selectedDomain);
    return [...pool].sort((a, b) => {
      const tDiff = (tierOrder[a.tier] ?? 9) - (tierOrder[b.tier] ?? 9);
      if (tDiff !== 0) return tDiff;
      return a.mastery - b.mastery;
    });
  }, [skills, selectedDomain, isAllMode]);

  const domainWorkLogs = useMemo(
    () =>
      isAllMode
        ? workLogs
        : workLogs.filter((l) => l.primaryDomain === selectedDomain),
    [workLogs, selectedDomain, isAllMode]
  );

  const domainCompletedMissions = useMemo(
    () =>
      missions.filter(
        (m) =>
          m.status === 'completed' &&
          (isAllMode || m.primaryDomain === selectedDomain)
      ),
    [missions, selectedDomain, isAllMode]
  );

  useEffect(() => {
    if (selectedDomain !== 'All') {
      setJobDomain(selectedDomain);
    }
  }, [selectedDomain]);

  // Keep selectedStepId anchored when switching domains, sequence modes, or updating roadmaps
  useEffect(() => {
    if (flattenedSteps.length === 0) {
      setSelectedStepId(null);
      return;
    }
    const stillExists = flattenedSteps.some((item) => item.uidKey === selectedStepId);
    if (!stillExists) {
      setSelectedStepId(nextFocusStepId || flattenedSteps[0].uidKey);
    }
  }, [
    selectedDomain,
    sequenceMode,
    currentRoadmap?.updatedAtIso,
    flattenedSteps,
    selectedStepId,
    nextFocusStepId,
  ]);

  useEffect(() => {
    if (inspectorBodyRef.current) {
      inspectorBodyRef.current.scrollTop = 0;
    }
    if (mobileInspectorBodyRef.current) {
      mobileInspectorBodyRef.current.scrollTop = 0;
    }
  }, [selectedStepId, viewMode]);

  useEffect(() => {
    setMobileInspectorOpen(false);
  }, [selectedDomain, viewMode]);

  useEffect(() => {
    if (!mobileInspectorOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMobileInspectorOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileInspectorOpen]);

  const selectedEntry = useMemo(() => {
    if (flattenedSteps.length === 0) return null;
    return (
      flattenedSteps.find((item) => item.uidKey === selectedStepId) ||
      flattenedSteps.find((item) => item.uidKey === nextFocusStepId) ||
      flattenedSteps[0]
    );
  }, [flattenedSteps, selectedStepId, nextFocusStepId]);

  const stepCodeById = useMemo(() => {
    const map = new globalThis.Map<string, string>();
    flattenedSteps.forEach((item) => map.set(item.uidKey, item.stepCode));
    return map;
  }, [flattenedSteps]);

  const pendingStepsCount = useMemo(
    () => flattenedSteps.filter((item) => !item.step.completed).length,
    [flattenedSteps]
  );
  const doneStepsCount = flattenedSteps.length - pendingStepsCount;
  const unifiedSequencePct =
    flattenedSteps.length > 0
      ? Math.round((doneStepsCount / flattenedSteps.length) * 100)
      : 0;

  const filteredStages = useMemo(() => {
    if (stepFilter === 'all') return activeStages;
    return activeStages
      .map((stage) => ({
        ...stage,
        steps: stage.steps.filter((item) =>
          stepFilter === 'done' ? item.step.completed : !item.step.completed
        ),
      }))
      .filter((stage) => stage.steps.length > 0);
  }, [activeStages, stepFilter]);

  const isDesigningCurrent =
    designingDomain === selectedDomain || designingDomain === 'All';
  const isDesigningAll = designingDomain === 'All';

  const handleSelectStepNode = (uidKey: string) => {
    setSelectedStepId(uidKey);
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setMobileInspectorOpen(true);
    }
  };

  const handleOpenJobForm = () => {
    setShowJobForm((prev) => {
      const next = !prev;
      if (next) {
        setJobDomain(
          selectedDomain !== 'All'
            ? selectedDomain
            : selectedEntry?.sourceDomain || 'AWS'
        );
        if (activeProject && !jobTitle.trim()) {
          setJobTitle(activeProject.projectName);
        }
        setAlsoClearActiveOverride(Boolean(activeProject));
      }
      return next;
    });
  };

  const handleToggleStep = async (uidKey: string) => {
    if (togglingStepId) return;
    const entry = flattenedSteps.find((item) => item.uidKey === uidKey);
    if (!entry) return;

    setTogglingStepId(uidKey);
    setError(null);
    try {
      if (entry.sourceType === 'roadmap' && entry.sourceRoadmap) {
        const result = await toggleRoadmapStepCompletion(
          profile.userId,
          entry.sourceRoadmap,
          entry.step.id,
          skills
        );
        if (result.completedNow) {
          onNotify?.(
            `Completed "${result.stepTitle}" (${entry.sourceDomain}) and boosted domain mastery.`
          );
        }
      } else if (entry.sourceType === 'skill' && entry.sourceSkill) {
        const nextMastery = entry.sourceSkill.mastery >= 80 ? 60 : 85;
        await updateSkillMastery(
          profile.userId,
          entry.sourceSkill,
          nextMastery,
          nextMastery >= 80
        );
        if (nextMastery >= 80) {
          onNotify?.(
            `Marked "${entry.step.title}" (${entry.sourceDomain}) done at ${nextMastery}% mastery.`
          );
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update roadmap step.');
    } finally {
      setTogglingStepId(null);
    }
  };

  const handleMarkJobDoneAndResume = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jobTitle.trim() || submittingJob) return;

    setSubmittingJob(true);
    setError(null);
    try {
      const cleanTitle = jobTitle.trim();
      const cleanSummary =
        jobSummary.trim() ||
        `Completed production job task "${cleanTitle}" in ${jobDomain}.`;
      const minutes = Math.min(1440, Math.max(15, Number(jobMinutes) || 60));

      const mapped = await mapWorkLogWithAi({
        projectName: cleanTitle,
        taskSummary: cleanSummary,
        minutesSpent: minutes,
        currentSkills: skills,
      });

      const pendingProjectQuests = todayQuests.filter(
        (q) => q.status === 'pending' && q.mode === 'project_override'
      );

      const res = await markJobTaskDoneAndResumePath(
        profile.userId,
        profile,
        skills,
        roadmaps,
        {
          jobTitle: cleanTitle,
          taskSummary: cleanSummary,
          domain: jobDomain,
          extractedSkills: mapped.extractedSkills,
          matchedSkillTitles: mapped.matchedSkillTitles,
          elevationNote: mapped.elevationNote,
          xpAwarded: Math.max(110, mapped.xpAwarded),
          minutesSpent: minutes,
          activeProject,
          pendingProjectQuests,
          markActiveProjectDone: Boolean(activeProject && alsoClearActiveOverride),
        }
      );

      if (res.exitedOverride || todayQuests.length === 0) {
        const normalResult = await generateDailyQuestsWithSystemAi({
          dateKey: todayKey,
          todaySlot,
          mode: 'normal_routine',
          activeProject: null,
          skills,
          recentWorkLogs: workLogs,
          domainFocusMinutes: profile.domainFocusMinutes,
          dueCardsCount,
          weeklyHoursTarget: profile.weeklyHoursTarget,
        });

        await saveGeneratedDailyQuests(
          profile.userId,
          todayKey,
          'normal_routine',
          null,
          [],
          normalResult.dailyQuests
        );
      }

      setJobTitle('');
      setJobSummary('');
      setShowJobForm(false);
      onSelectDomain(jobDomain);

      const roadmapNote =
        res.stepsCompletedCount > 0
          ? `${res.stepsCompletedCount} ${jobDomain} roadmap step${res.stepsCompletedCount > 1 ? 's' : ''} marked done.`
          : `${jobDomain} mastery & work history credited.`;

      onCelebrate({
        kind: 'project',
        title: `Job Task Marked Done · ${cleanTitle}`,
        subtitle: `${roadmapNote} ${
          res.exitedOverride
            ? 'Exited project override and resumed your balanced Normal Learning Path.'
            : 'Learning path resumed cleanly.'
        }`,
        xpAwarded: Math.max(110, mapped.xpAwarded),
        domain: jobDomain,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to mark job task complete and resume path.'
      );
    } finally {
      setSubmittingJob(false);
    }
  };

  const findLinkedSkill = (skillTitle: string, domainHint?: Domain) => {
    const targetLower = skillTitle.toLowerCase();
    const pool = domainHint
      ? skills.filter((s) => s.domain === domainHint)
      : domainSkills;
    return (
      pool.find((s) => s.title.toLowerCase() === targetLower) ||
      pool.find(
        (s) =>
          s.title.toLowerCase().includes(targetLower) ||
          targetLower.includes(s.title.toLowerCase())
      ) ||
      null
    );
  };

  const buildStepDetailContent = (step: DomainRoadmapStep, domainHint?: Domain) => {
    const linkedSkill = findLinkedSkill(step.skillTitle || step.title, domainHint);
    const hasNativeGuide = Boolean(step.detailedGuide && step.detailedGuide.trim().length > 20);
    const guideText = hasNativeGuide
      ? step.detailedGuide!.trim()
      : [
          linkedSkill?.studyBrief
            ? `Architecture & Curriculum Context: ${linkedSkill.studyBrief}`
            : `Execution Breakdown: Focus on implementing ${step.title} end-to-end with production failure handling, instrumentation, and automated verification.`,
          step.deliverables?.length
            ? `Build Sequence: ${step.deliverables.map((d, i) => `(${i + 1}) ${d}`).join(' ')}`
            : '',
          step.labObjective ? `Verification Target: ${step.labObjective}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

    const pitfalls =
      step.keyPitfalls && step.keyPitfalls.length > 0
        ? step.keyPitfalls
        : linkedSkill?.labPrompt
        ? [
            `Skipping verification under failure conditions — ensure you explicitly validate: ${linkedSkill.labPrompt}`,
            'Treating happy-path setup as complete without measuring latency, permissions, or rollback safety.',
          ]
        : [
            'Stopping at defaults without testing failure recovery, strict security boundaries, and rollback paths.',
          ];

    return {
      linkedSkill,
      hasNativeGuide,
      guideBlocks: splitReadableBlocks(guideText),
      descriptionBlocks: splitReadableBlocks(step.description),
      pitfalls,
    };
  };

  const selectedDetail = selectedEntry
    ? buildStepDetailContent(selectedEntry.step, selectedEntry.sourceDomain)
    : null;

  const prevEntry =
    selectedEntry && selectedEntry.globalIndex > 0
      ? flattenedSteps[selectedEntry.globalIndex - 1]
      : null;
  const nextEntry =
    selectedEntry && selectedEntry.globalIndex < flattenedSteps.length - 1
      ? flattenedSteps[selectedEntry.globalIndex + 1]
      : null;

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3.5 rounded-lg bg-red-950/40 border border-red-800/60 text-sm text-red-200">
          {error}
        </div>
      )}

      {/* Unified Master Sequential Selector + 5-Domain Strip */}
      <section aria-label="Unified master roadmap and domain selector" className="space-y-3">
        <button
          type="button"
          onClick={() => onSelectDomain('All')}
          className={`w-full text-left p-4 sm:px-5 rounded-xl border transition-colors cursor-pointer flex flex-col lg:flex-row lg:items-center justify-between gap-3 lg:gap-4 ${
            isAllMode
              ? 'bg-[#141D2D] border-sky-400/75 shadow-sm shadow-sky-500/10'
              : 'bg-[#121824] border-slate-800/80 hover:border-slate-700'
          }`}
        >
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-[11px] font-mono text-sky-400">
              <Layers className="w-3.5 h-3.5 shrink-0" />
              <span>UNIFIED MASTER SEQUENCE</span>
              <span className="text-slate-600 hidden sm:inline">·</span>
              <span className="text-slate-300">
                01 Angular → 02 FastAPI → 03 DevOps → 04 AWS → 05 GCP
              </span>
            </div>
            <div className="font-display text-sm sm:text-base font-semibold text-slate-50">
              Combined Top 1% Full-Stack &amp; Multi-Cloud Sequence
            </div>
          </div>

          <div className="grid grid-cols-3 sm:flex sm:flex-wrap items-center gap-2 sm:gap-4 text-[11px] sm:text-xs font-mono tabular-nums shrink-0 pt-2 lg:pt-0 border-t lg:border-t-0 border-slate-800/80">
            <span className={isAllMode ? 'text-sky-300 font-semibold' : 'text-slate-300'}>
              Avg Lv. {unifiedMasterStats.avgLevel}/10
            </span>
            <span className="text-slate-700 hidden sm:inline">·</span>
            <span className="text-emerald-300 text-center sm:text-left">
              {unifiedMasterStats.designedCount}/5 Roadmaps
            </span>
            <span className="text-slate-700 hidden sm:inline">·</span>
            <span className="text-slate-300 text-right sm:text-left">
              {unifiedMasterStats.avgReadiness}% Ready
            </span>
          </div>
        </button>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2.5 sm:gap-3">
        {domainStatsList.map((stat, idx) => {
          const isSelected = stat.domain === selectedDomain;
          const hasRoadmap = Boolean(roadmaps[stat.domain]);
          return (
            <button
              key={stat.domain}
              type="button"
              onClick={() => onSelectDomain(stat.domain)}
              className={`text-left p-3 sm:p-4 rounded-xl border transition-colors cursor-pointer space-y-2 ${
                idx === domainStatsList.length - 1 ? 'col-span-2 sm:col-span-1' : ''
              } ${
                isSelected
                  ? 'bg-[#141D2D] border-sky-400/70 shadow-sm shadow-sky-500/10'
                  : 'bg-[#121824] border-slate-800/80 hover:border-slate-700'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-sm font-semibold text-slate-50">
                  {stat.domain}
                </span>
                <span
                  className={`font-mono text-xs font-semibold tabular-nums ${
                    isSelected ? 'text-sky-300' : 'text-slate-300'
                  }`}
                >
                  Lv. {stat.level}/{stat.maxLevel}
                </span>
              </div>

              <div className="text-[11px] font-mono text-slate-400 truncate">
                {stat.rankTitle}
              </div>

              <div className="w-full h-1.5 rounded-full bg-[#0B0F17] overflow-hidden border border-slate-800/80">
                <div
                  className={`h-full transition-all duration-300 ${
                    stat.readinessScore >= 80
                      ? 'bg-emerald-400'
                      : isSelected
                      ? 'bg-sky-400'
                      : 'bg-sky-500/70'
                  }`}
                  style={{ width: `${stat.readinessScore}%` }}
                />
              </div>

              <div className="flex items-center justify-between gap-1 text-[11px] font-mono text-slate-500 tabular-nums">
                <span>Mastery {stat.avgMastery}%</span>
                <span className="truncate">
                  {hasRoadmap
                    ? `${stat.roadmapStepsDone}/${stat.roadmapStepsTotal}`
                    : 'Seed'}
                </span>
              </div>
            </button>
          );
        })}
        </div>
      </section>

      {/* Active Project Override Alert (if active) */}
      {activeProject && (
        <section className="bg-[#121824] border border-amber-500/35 rounded-xl p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1 max-w-2xl">
            <div className="text-xs font-mono text-amber-400">
              ACTIVE PROJECT OVERRIDE · {activeProject.primaryDomain}
            </div>
            <div className="text-sm font-semibold text-slate-100">
              {activeProject.projectName}
            </div>
            <p className="text-xs text-slate-300">
              Already finished this or another prior job task? Mark it done below to credit your
              roadmap, boost mastery, and resume your balanced 5-domain path.
            </p>
          </div>
          <button
            type="button"
            onClick={handleOpenJobForm}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 min-h-[42px] sm:min-h-0 py-2 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
          >
            <Flag className="w-3.5 h-3.5" />
            <span>Mark Job Done &amp; Resume</span>
          </button>
        </section>
      )}

      {/* Selected Domain (or Unified Sequence) Level & JARVIS Architecture Hero */}
      <section className="bg-[#121824] border border-sky-500/35 rounded-xl overflow-hidden">
        <div className="p-4 sm:px-6 sm:py-5 border-b border-slate-800/80 flex flex-col lg:flex-row lg:items-start justify-between gap-4">
          <div className="space-y-1.5 max-w-2xl min-w-0">
            <div className="flex items-center gap-2 text-xs font-mono text-sky-400">
              <Map className="w-4 h-4 shrink-0" />
              <span className="truncate">
                {isAllMode
                  ? 'JARVIS UNIFIED SEQUENCE · 5 STACKS'
                  : `JARVIS TOP 1% ROADMAP · ${selectedDomain.toUpperCase()}`}
              </span>
            </div>
            <h2 className="font-display text-lg sm:text-xl font-semibold text-slate-50">
              {isAllMode
                ? 'Combined Top 1% Full-Stack & Multi-Cloud Sequence'
                : currentRoadmap?.title || `${selectedDomain} Top 1% Mastery Path`}
            </h2>
            <p className="text-xs text-slate-300 leading-relaxed">
              {isAllMode
                ? 'One continuous sequence combining every domain from client reactivity and async APIs through containers, AWS infrastructure, and GCP multi-cloud scale. Any step ticked here stays synchronized with its domain roadmap and curriculum mastery.'
                : currentRoadmap?.visionSummary ||
                  `Let JARVIS architect a 4-stage production roadmap tailored to your current ${selectedDomain} mastery, completed job history, and Top 1% engineering gaps.`}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:flex sm:flex-wrap items-center gap-2 w-full lg:w-auto shrink-0">
            {isAllMode ? (
              <>
                {missingRoadmapDomains.length > 0 && (
                  <button
                    type="button"
                    disabled={Boolean(designingDomain)}
                    onClick={() =>
                      void onDesignAllRoadmaps({
                        onlyMissing: true,
                        focusGoal: focusGoalInput.trim() || undefined,
                      })
                    }
                    className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[42px] sm:min-h-0 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    {isDesigningAll ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        <span>
                          {designingProgress
                            ? `Designing ${designingProgress.domain} (${designingProgress.current}/${designingProgress.total})...`
                            : 'Designing Missing...'}
                        </span>
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>Design Missing ({missingRoadmapDomains.length}) with JARVIS</span>
                      </>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  disabled={Boolean(designingDomain)}
                  onClick={() =>
                    void onDesignAllRoadmaps({
                      onlyMissing: false,
                      focusGoal: focusGoalInput.trim() || undefined,
                    })
                  }
                  className={`w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[42px] sm:min-h-0 py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 disabled:opacity-50 ${
                    missingRoadmapDomains.length === 0
                      ? 'bg-sky-500 hover:bg-sky-400 text-slate-950'
                      : 'border border-slate-700/80 bg-[#0B0F17] hover:bg-slate-800 text-slate-200'
                  }`}
                >
                  {isDesigningAll ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                      <span>
                        {designingProgress
                          ? `Designing ${designingProgress.domain} (${designingProgress.current}/${designingProgress.total})...`
                          : 'Designing All 5...'}
                      </span>
                    </>
                  ) : (
                    <>
                      <Layers className="w-3.5 h-3.5" />
                      <span>
                        {missingRoadmapDomains.length === 0
                          ? 'Upgrade All 5 with JARVIS'
                          : 'Regenerate All 5'}
                      </span>
                    </>
                  )}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  disabled={Boolean(designingDomain)}
                  onClick={() =>
                    void onDesignRoadmap(selectedDomain, focusGoalInput.trim() || undefined)
                  }
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[42px] sm:min-h-0 py-2 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  {isDesigningCurrent ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Designing...</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>
                        {currentRoadmap
                          ? `Upgrade ${selectedDomain} Roadmap`
                          : `Design ${selectedDomain} Roadmap`}
                      </span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={Boolean(designingDomain)}
                  onClick={() =>
                    void onDesignAllRoadmaps({
                      onlyMissing: false,
                      focusGoal: focusGoalInput.trim() || undefined,
                    })
                  }
                  className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[42px] sm:min-h-0 py-2 rounded-lg border border-slate-700/80 bg-[#0B0F17] hover:bg-slate-800 disabled:opacity-50 text-xs font-medium text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  {isDesigningAll ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-400" />
                      <span>
                        {designingProgress
                          ? `Designing ${designingProgress.domain} (${designingProgress.current}/${designingProgress.total})...`
                          : 'Designing All 5...'}
                      </span>
                    </>
                  ) : (
                    <>
                      <Layers className="w-3.5 h-3.5 text-sky-400" />
                      <span>Design All 5 with JARVIS</span>
                    </>
                  )}
                </button>
              </>
            )}

            <button
              type="button"
              onClick={handleOpenJobForm}
              className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[42px] sm:min-h-0 py-2 rounded-lg border border-emerald-500/40 bg-emerald-500/10 hover:bg-emerald-500/20 text-xs font-semibold text-emerald-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Briefcase className="w-3.5 h-3.5" />
              <span>Mark Job Done &amp; Resume</span>
            </button>

            {onAskJarvis && (
              <button
                type="button"
                onClick={() =>
                  onAskJarvis(
                    isAllMode
                      ? `Review my unified 5-domain sequence (currently ${doneStepsCount}/${flattenedSteps.length} steps done, Avg Lv. ${unifiedMasterStats.avgLevel}/10) and coach me on the highest-leverage next step.`
                      : `Review my ${selectedDomain} roadmap (currently Lv. ${selectedStats.level}/10, ${selectedStats.avgMastery}% mastery) and coach me on the highest-leverage next step.`
                  )
                }
                className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[42px] sm:min-h-0 py-2 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 text-xs font-medium text-sky-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                <Bot className="w-3.5 h-3.5" />
                <span>Coach Next Step</span>
              </button>
            )}
          </div>
        </div>

        {/* 4 Domain Level & Progression Telemetry Cells */}
        {isAllMode ? (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-slate-800/80">
            <div className="bg-[#121824] p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-400">Unified Engineer Level</div>
              <div className="font-mono text-lg sm:text-xl font-semibold text-sky-300 tabular-nums">
                Avg Lv. {unifiedMasterStats.avgLevel} / 10
              </div>
              <div className="text-xs font-mono text-slate-400 tabular-nums">
                {unifiedMasterStats.avgMastery}% overall mastery
              </div>
            </div>

            <div className="bg-[#121824] p-4 sm:p-5 space-y-1.5">
              <div className="flex items-center justify-between gap-1 text-xs text-slate-400">
                <span>Combined Readiness</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {unifiedMasterStats.avgReadiness}%
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-[#0B0F17] overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-sky-400 transition-all duration-300"
                  style={{ width: `${unifiedMasterStats.avgReadiness}%` }}
                />
              </div>
              <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                {unifiedMasterStats.designedCount}/5 blueprints ·{' '}
                {unifiedMasterStats.totalDomainXp} XP
              </div>
            </div>

            <div className="bg-[#121824] p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-400">Sequence Progress</div>
              <div className="font-mono text-lg sm:text-xl font-semibold text-slate-50 tabular-nums">
                {doneStepsCount} / {flattenedSteps.length}
              </div>
              <div className="text-xs font-mono text-emerald-400 tabular-nums">
                {unifiedSequencePct}% unified steps cleared
              </div>
            </div>

            <div className="bg-[#121824] p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-400">Top 1% Nodes &amp; Jobs</div>
              <div className="font-mono text-lg sm:text-xl font-semibold text-slate-50 tabular-nums">
                {unifiedMasterStats.top1NodesReady}/{unifiedMasterStats.top1NodesTotal} Nodes
              </div>
              <div className="text-xs font-mono text-slate-400 tabular-nums">
                {unifiedMasterStats.completedJobsCount} job task
                {unifiedMasterStats.completedJobsCount === 1 ? '' : 's'} credited
              </div>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-slate-800/80">
            <div className="bg-[#121824] p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-400">{selectedDomain} Level</div>
              <div className="font-mono text-lg sm:text-xl font-semibold text-sky-300 tabular-nums">
                Lv. {selectedStats.level} / {selectedStats.maxLevel}
              </div>
              <div className="text-xs font-mono text-slate-400 truncate">
                {selectedStats.rankTitle}
              </div>
            </div>

            <div className="bg-[#121824] p-4 sm:p-5 space-y-1.5">
              <div className="flex items-center justify-between gap-1 text-xs text-slate-400">
                <span>Readiness &amp; Next Level</span>
                <span className="font-mono tabular-nums text-slate-200">
                  {selectedStats.readinessScore}%
                </span>
              </div>
              <div className="w-full h-2 rounded-full bg-[#0B0F17] overflow-hidden border border-slate-800">
                <div
                  className="h-full bg-sky-400 transition-all duration-300"
                  style={{ width: `${selectedStats.progressToNextLevelPct}%` }}
                />
              </div>
              <div className="text-[11px] font-mono text-slate-500 tabular-nums">
                {selectedStats.level < 10
                  ? `${selectedStats.progressToNextLevelPct}% to Lv. ${selectedStats.level + 1} · ${selectedStats.domainXp} XP`
                  : `Apex Tier Unlocked · ${selectedStats.domainXp} XP`}
              </div>
            </div>

            <div className="bg-[#121824] p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-400">Roadmap Progress</div>
              <div className="font-mono text-lg sm:text-xl font-semibold text-slate-50 tabular-nums">
                {selectedStats.roadmapStepsDone} / {selectedStats.roadmapStepsTotal || 12}
              </div>
              <div className="text-xs font-mono text-emerald-400 tabular-nums">
                {currentRoadmap
                  ? `${selectedStats.roadmapPct}% steps cleared`
                  : 'Generate with JARVIS'}
              </div>
            </div>

            <div className="bg-[#121824] p-4 sm:p-5 space-y-1">
              <div className="text-xs text-slate-400">Top 1% Nodes &amp; Jobs</div>
              <div className="font-mono text-lg sm:text-xl font-semibold text-slate-50 tabular-nums">
                {selectedStats.top1NodesReady}/{selectedStats.top1NodesTotal} Nodes
              </div>
              <div className="text-xs font-mono text-slate-400 tabular-nums">
                {selectedStats.completedJobsCount} job task
                {selectedStats.completedJobsCount === 1 ? '' : 's'} credited
              </div>
            </div>
          </div>
        )}
      </section>

      {/* Inline Form: Mark Priorly Completed or Active Job Task Done & Resume Path */}
      {showJobForm && (
        <section className="bg-[#121824] border border-emerald-500/40 rounded-xl p-6 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2 text-xs font-mono text-emerald-400">
                <Briefcase className="w-4 h-4" />
                <span>JOB TASK COMPLETION &amp; PATH RESUMPTION</span>
              </div>
              <h3 className="font-display text-base font-semibold text-slate-50">
                Mark Job Task Completed &amp; Resume Normal Learning Path
              </h3>
              <p className="text-xs text-slate-400 max-w-2xl">
                If you already completed a work project or sprint task priorly, record it here.
                ApexStack will tick off matching {jobDomain} roadmap steps, credit skill mastery
                and XP, and return your syllabus to the normal learning path.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowJobForm(false)}
              className="text-xs text-slate-400 hover:text-slate-200 cursor-pointer"
            >
              Close
            </button>
          </div>

          <form onSubmit={handleMarkJobDoneAndResume} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="md:col-span-2 space-y-1.5">
                <label
                  htmlFor="roadmap-job-title"
                  className="block text-xs font-medium text-slate-300"
                >
                  Completed Job / Project Task Name
                </label>
                <input
                  id="roadmap-job-title"
                  type="text"
                  required
                  maxLength={120}
                  value={jobTitle}
                  onChange={(e) => setJobTitle(e.target.value)}
                  placeholder="e.g., EKS OIDC IRSA Migration & Blue/Green Rollout"
                  className="w-full px-3.5 py-2.5 rounded-lg bg-[#0B0F17] border border-slate-800 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <label
                    htmlFor="roadmap-job-domain"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Domain
                  </label>
                  <select
                    id="roadmap-job-domain"
                    value={jobDomain}
                    onChange={(e) => setJobDomain(e.target.value as Domain)}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#0B0F17] border border-slate-800 text-sm text-slate-100 focus:outline-none focus:border-emerald-500"
                  >
                    {DOMAINS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="roadmap-job-minutes"
                    className="block text-xs font-medium text-slate-300"
                  >
                    Minutes
                  </label>
                  <input
                    id="roadmap-job-minutes"
                    type="number"
                    min={15}
                    max={1440}
                    value={jobMinutes}
                    onChange={(e) => setJobMinutes(Number(e.target.value))}
                    className="w-full px-3 py-2.5 rounded-lg bg-[#0B0F17] border border-slate-800 text-sm font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="roadmap-job-summary"
                className="block text-xs font-medium text-slate-300"
              >
                What You Built / Delivered (Optional)
              </label>
              <textarea
                id="roadmap-job-summary"
                rows={3}
                maxLength={2500}
                value={jobSummary}
                onChange={(e) => setJobSummary(e.target.value)}
                placeholder="Describe key architecture decisions, fixes, or deliverables completed in this job task..."
                className="w-full px-3.5 py-2.5 rounded-lg bg-[#0B0F17] border border-slate-800 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />
            </div>

            {activeProject && (
              <label className="flex items-center gap-2.5 text-xs text-slate-200 cursor-pointer">
                <input
                  type="checkbox"
                  checked={alsoClearActiveOverride}
                  onChange={(e) => setAlsoClearActiveOverride(e.target.checked)}
                  className="rounded border-slate-700 bg-[#0B0F17] text-emerald-500 focus:ring-emerald-500"
                />
                <span>
                  Also clear active project override &ldquo;{activeProject.projectName}&rdquo; and
                  issue today&apos;s Normal Routine quests
                </span>
              </label>
            )}

            <div className="flex flex-wrap items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowJobForm(false)}
                className="px-4 py-2 rounded-lg border border-slate-700 text-xs text-slate-300 hover:text-slate-100 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submittingJob || !jobTitle.trim()}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
              >
                {submittingJob ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Crediting Mastery &amp; Resuming Path...</span>
                  </>
                ) : (
                  <>
                    <Flag className="w-3.5 h-3.5" />
                    <span>Mark Job Done &amp; Resume Path</span>
                  </>
                )}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Custom Focus Goal Re-Architect Bar */}
      <section className="bg-[#121824] border border-slate-800/80 rounded-xl p-3.5 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-2.5 sm:gap-3">
        <Compass className="w-4 h-4 text-sky-400 shrink-0 hidden sm:inline" />
        <input
          type="text"
          maxLength={200}
          value={focusGoalInput}
          onChange={(e) => setFocusGoalInput(e.target.value)}
          placeholder={
            isAllMode
              ? 'Optional JARVIS focus directive across all 5 domains...'
              : `Optional JARVIS focus directive for ${selectedDomain}...`
          }
          className="w-full sm:flex-1 min-w-0 px-3.5 min-h-[42px] sm:min-h-0 py-2 rounded-lg bg-[#0B0F17] border border-slate-800 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-sky-500"
        />
        <button
          type="button"
          disabled={Boolean(designingDomain)}
          onClick={() => {
            const goal = focusGoalInput.trim() || undefined;
            if (isAllMode) {
              void onDesignAllRoadmaps({ onlyMissing: false, focusGoal: goal });
            } else {
              void onDesignRoadmap(selectedDomain, goal);
            }
          }}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[42px] sm:min-h-0 py-2 rounded-lg border border-sky-500/40 bg-sky-500/10 hover:bg-sky-500/20 disabled:opacity-50 text-xs font-semibold text-sky-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          {isDesigningCurrent ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Re-Architecting...</span>
            </>
          ) : (
            <span>
              {isAllMode
                ? 'Tailor All 5 with JARVIS'
                : currentRoadmap
                ? 'Tailor Roadmap with JARVIS'
                : 'Generate Roadmap'}
            </span>
          )}
        </button>
      </section>

      {/* Main Content: Empty Preview (single unbuilt domain) or roadmap.sh Flowchart + Step Inspector */}
      {!isAllMode && !currentRoadmap ? (
        <section className="bg-[#121824] border border-slate-800/80 rounded-xl p-6 sm:p-8 space-y-6">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="space-y-1 max-w-xl">
              <h3 className="font-display text-lg font-semibold text-slate-50">
                No JARVIS Roadmap Saved for {selectedDomain} Yet
              </h3>
              <p className="text-xs text-slate-400 leading-relaxed">
                Have JARVIS synthesize a 4-stage Top 1% interactive roadmap graph for{' '}
                {selectedDomain} aligned to your {domainSkills.length} current curriculum nodes
                and real-world job history, with detailed architecture guides for every step.
              </p>
            </div>
            <button
              type="button"
              disabled={Boolean(designingDomain)}
              onClick={() =>
                void onDesignRoadmap(selectedDomain, focusGoalInput.trim() || undefined)
              }
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-slate-950 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {isDesigningCurrent ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>JARVIS Designing {selectedDomain}...</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Let JARVIS Design {selectedDomain} Roadmap</span>
                </>
              )}
            </button>
          </div>

          {domainSkills.length > 0 && (
            <div className="space-y-3 pt-4 border-t border-slate-800/80">
              <div className="text-[11px] font-mono uppercase tracking-wider text-slate-400">
                Current {selectedDomain} Syllabus Nodes ({domainSkills.length})
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {domainSkills.map((sk) => (
                  <div
                    key={sk.id}
                    className="p-3.5 rounded-lg bg-[#0B0F17] border border-slate-800/80 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-slate-100 truncate">
                        {sk.title}
                      </div>
                      <div className="text-[11px] font-mono text-slate-500">{sk.tier}</div>
                    </div>
                    <span className="font-mono text-xs text-sky-300 tabular-nums shrink-0">
                      {sk.mastery}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : (
        <div className="space-y-4">
          {/* View Mode Bar + Sequence Strategy (Unified Mode) + Step Status Filter + Legend */}
          <div className="bg-[#121824] border border-slate-800/80 rounded-xl p-3 sm:px-4 sm:py-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 min-w-0">
              <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#0B0F17] border border-slate-800 overflow-x-auto max-w-full">
                <button
                  type="button"
                  onClick={() => setViewMode('graph')}
                  className={`inline-flex items-center gap-1.5 px-3 min-h-[36px] sm:min-h-0 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    viewMode === 'graph'
                      ? 'bg-sky-500 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-slate-100'
                  }`}
                >
                  <GitBranch className="w-3.5 h-3.5" />
                  <span>Roadmap Graph</span>
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('list')}
                  className={`inline-flex items-center gap-1.5 px-3 min-h-[36px] sm:min-h-0 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                    viewMode === 'list'
                      ? 'bg-sky-500 text-slate-950 font-semibold'
                      : 'text-slate-300 hover:text-slate-100'
                  }`}
                >
                  <ListTree className="w-3.5 h-3.5" />
                  <span>Detailed List</span>
                </button>
              </div>

              {isAllMode && (
                <div
                  className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#0B0F17] border border-slate-800 overflow-x-auto max-w-full"
                  role="group"
                  aria-label="Unified roadmap sequence order"
                >
                  <button
                    type="button"
                    onClick={() => setSequenceMode('stack')}
                    className={`px-2.5 min-h-[36px] sm:min-h-0 py-1.5 rounded-md text-[11px] font-mono transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      sequenceMode === 'stack'
                        ? 'bg-slate-800 text-sky-300 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Stack Order (1→5)
                  </button>
                  <button
                    type="button"
                    onClick={() => setSequenceMode('tier')}
                    className={`px-2.5 min-h-[36px] sm:min-h-0 py-1.5 rounded-md text-[11px] font-mono transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      sequenceMode === 'tier'
                        ? 'bg-slate-800 text-sky-300 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    Tier Lockstep
                  </button>
                </div>
              )}

              <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#0B0F17] border border-slate-800 overflow-x-auto max-w-full">
                {(
                  [
                    { id: 'all', label: `All (${flattenedSteps.length})` },
                    { id: 'pending', label: `Pending (${pendingStepsCount})` },
                    { id: 'done', label: `Done (${doneStepsCount})` },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => setStepFilter(opt.id)}
                    className={`px-2.5 min-h-[36px] sm:min-h-0 py-1.5 rounded-md text-[11px] font-mono transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                      stepFilter === opt.id
                        ? 'bg-slate-800 text-sky-300 font-semibold'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px] font-mono text-slate-400 shrink-0">
              <span className="inline-flex items-center gap-1.5 text-emerald-300">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" />
                Completed
              </span>
              <span className="text-slate-700">·</span>
              <span className="inline-flex items-center gap-1.5 text-amber-300">
                <span className="w-2.5 h-2.5 rounded-full bg-amber-400 inline-block" />
                Next Focus
              </span>
              <span className="text-slate-700">·</span>
              <span className="inline-flex items-center gap-1.5 text-sky-300">
                <span className="w-2.5 h-2.5 rounded-full bg-sky-400 inline-block" />
                Selected
              </span>
            </div>
          </div>

          {viewMode === 'graph' ? (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
              {/* Left: roadmap.sh Interactive Spine-and-Branch Diagram */}
              <section
                ref={graphRef}
                aria-label={`${
                  isAllMode ? 'Unified 5-domain sequential' : selectedDomain
                } interactive roadmap flowchart`}
                className="lg:col-span-7 bg-[#0B0F17] border border-slate-800/90 rounded-xl p-4 sm:p-6 overflow-hidden"
              >
                {/* Root Mastery Trunk Node */}
                <div className="flex flex-col items-center">
                  <div className="w-full max-w-md rounded-lg border border-sky-500/50 bg-[#121824] px-4 py-3 text-center space-y-1">
                    <div className="text-[11px] font-mono uppercase tracking-wider text-sky-400">
                      {isAllMode
                        ? sequenceMode === 'stack'
                          ? 'UNIFIED STACK · ANGULAR → FASTAPI → DEVOPS → AWS → GCP'
                          : 'TIER LOCKSTEP · FOUNDATIONAL → SENIOR → TOP 1%'
                        : `${selectedDomain} · ${currentRoadmap?.targetRank || 'Top 1%'}`}
                    </div>
                    <div className="font-display text-sm font-semibold text-slate-50">
                      {isAllMode
                        ? 'Top 1% Master Sequential Roadmap'
                        : currentRoadmap?.title}
                    </div>
                    <div className="text-[11px] font-mono text-slate-400 tabular-nums">
                      {isAllMode
                        ? `Avg Lv. ${unifiedMasterStats.avgLevel}/10 · ${doneStepsCount}/${flattenedSteps.length} cleared · ${activeStages.length} phases`
                        : `Lv. ${selectedStats.level}/${selectedStats.maxLevel} · ${selectedStats.roadmapStepsDone}/${selectedStats.roadmapStepsTotal} cleared`}
                    </div>
                  </div>
                  <div className="w-0.5 h-6 bg-slate-700" aria-hidden="true" />
                </div>

                {/* Stages along the Vertical Progression Spine */}
                {filteredStages.length === 0 ? (
                  <div className="py-10 text-center space-y-3">
                    <p className="text-xs text-slate-400">
                      No steps match the &ldquo;{stepFilter}&rdquo; filter on{' '}
                      {isAllMode ? 'Unified Sequence' : selectedDomain}.
                    </p>
                    <button
                      type="button"
                      onClick={() => setStepFilter('all')}
                      className="px-3.5 py-1.5 rounded-lg border border-slate-700 bg-[#121824] hover:border-sky-400 text-xs text-sky-300 cursor-pointer"
                    >
                      Show all steps
                    </button>
                  </div>
                ) : (
                  filteredStages.map((stage, stageIdx) => {
                    const sourceStage =
                      activeStages.find((st) => st.stageKey === stage.stageKey) || stage;
                    const stageDoneCount = sourceStage.steps.filter(
                      (item) => item.step.completed
                    ).length;
                    const stageTotalCount = sourceStage.steps.length;
                    const stageComplete =
                      stageTotalCount > 0 && stageDoneCount === stageTotalCount;
                    const isLastStage = stageIdx === filteredStages.length - 1;

                    return (
                      <div key={stage.stageKey} className="flex flex-col items-center">
                        {/* Centered Stage Spine Hub */}
                        <div
                          className={`w-full max-w-md rounded-lg border px-4 py-3 text-center space-y-1 ${
                            stageComplete
                              ? 'bg-emerald-950/25 border-emerald-500/50'
                              : 'bg-[#141C2B] border-amber-400/45'
                          }`}
                        >
                          <div className="flex flex-wrap items-center justify-center gap-2 text-[11px] font-mono tabular-nums">
                            <span className="text-sky-400 font-semibold">
                              {isAllMode
                                ? `PHASE ${String(stage.stageNumber).padStart(2, '0')} · ${stage.domain.toUpperCase()}`
                                : `STAGE ${stage.stageNumber}`}
                            </span>
                            <span className="text-slate-600">·</span>
                            <span
                              className={
                                stage.targetTier === 'Top 1%'
                                  ? 'text-amber-300'
                                  : stage.targetTier === 'Senior'
                                  ? 'text-sky-300'
                                  : 'text-slate-300'
                              }
                            >
                              {stage.targetTier}
                            </span>
                            <span className="text-slate-600">·</span>
                            <span className="text-slate-300">
                              {stageDoneCount}/{stageTotalCount} done
                            </span>
                            {isAllMode && stage.sourceType === 'skill' && (
                              <>
                                <span className="text-slate-600">·</span>
                                <span className="text-slate-400">Curriculum Seed</span>
                              </>
                            )}
                          </div>
                          <h3 className="font-display text-sm font-semibold text-slate-50">
                            {stage.title}
                          </h3>
                          {stage.milestoneGoal && (
                            <p className="text-[11px] text-slate-400 leading-snug">
                              {stage.milestoneGoal}
                            </p>
                          )}
                        </div>

                        {stage.steps.length > 0 && (
                          <div
                            className={`w-0.5 h-5 ${
                              stageComplete ? 'bg-emerald-500/50' : 'bg-slate-700'
                            }`}
                            aria-hidden="true"
                          />
                        )}

                        {/* Alternating Left / Right Branch Nodes */}
                        <div className="w-full">
                          {stage.steps.map((item, stepIdx) => {
                            const { step, uidKey, sourceDomain } = item;
                            const isLeft = stepIdx % 2 === 0;
                            const isSelected = selectedEntry?.uidKey === uidKey;
                            const isNextFocus = nextFocusStepId === uidKey;
                            const isLastStepInStage = stepIdx === stage.steps.length - 1;
                            const isVeryLastNode = isLastStage && isLastStepInStage;
                            const isBusy = togglingStepId === uidKey;
                            const linkedSkill = findLinkedSkill(
                              step.skillTitle || step.title,
                              sourceDomain
                            );
                            const stepCode =
                              stepCodeById.get(uidKey) || `${stage.stageNumber}.${stepIdx + 1}`;

                          const nodeCard = (
                            <div
                              className={`w-full rounded-lg border transition-colors ${
                                isSelected
                                  ? 'bg-[#162032] border-sky-400 shadow-sm shadow-sky-500/15'
                                  : step.completed
                                  ? 'bg-emerald-950/20 border-emerald-500/45 hover:border-emerald-400/70'
                                  : isNextFocus
                                  ? 'bg-[#131B2A] border-amber-400/60 hover:border-amber-300'
                                  : 'bg-[#121824] border-slate-800 hover:border-slate-600'
                              }`}
                            >
                              <button
                                type="button"
                                onClick={() => handleSelectStepNode(uidKey)}
                                className="w-full text-left p-3.5 space-y-1.5 cursor-pointer block"
                              >
                                <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
                                  <span
                                    className={
                                      step.completed
                                        ? 'text-emerald-300 font-semibold'
                                        : isSelected
                                        ? 'text-sky-300 font-semibold'
                                        : isNextFocus
                                        ? 'text-amber-300 font-semibold'
                                        : 'text-slate-400'
                                    }
                                  >
                                    {stepCode}
                                    {isAllMode ? ` · ${sourceDomain}` : ''} ·{' '}
                                    {step.completed
                                      ? 'Completed'
                                      : isNextFocus
                                      ? 'Next Focus'
                                      : 'Pending'}
                                  </span>
                                  {linkedSkill && (
                                    <span className="text-slate-400 shrink-0">
                                      {linkedSkill.mastery}%
                                    </span>
                                  )}
                                </div>

                                <div
                                  className={`text-xs sm:text-sm font-semibold leading-snug ${
                                    step.completed ? 'text-slate-200' : 'text-slate-50'
                                  }`}
                                >
                                  {step.title}
                                </div>

                                <p className="text-xs text-slate-400 leading-relaxed line-clamp-2">
                                  {step.description}
                                </p>

                                {step.completedJobTaskTag && (
                                  <div className="text-[11px] font-mono text-amber-300 truncate">
                                    Done via Job: {step.completedJobTaskTag}
                                  </div>
                                )}
                              </button>

                              <div className="px-3.5 py-2 border-t border-slate-800/70 flex items-center justify-between gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleSelectStepNode(uidKey)}
                                  className="min-h-[36px] inline-flex items-center text-[11px] font-mono text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
                                >
                                  {isSelected ? 'Inspecting guide →' : 'Read full guide →'}
                                </button>
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleToggleStep(uidKey)}
                                  className={`inline-flex items-center gap-1 px-2.5 min-h-[36px] sm:min-h-0 py-1 rounded text-[11px] font-semibold border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                                    step.completed
                                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25'
                                      : 'bg-[#0B0F17] border-slate-700 text-slate-200 hover:border-sky-400 hover:text-sky-200'
                                  }`}
                                >
                                  {isBusy ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : step.completed ? (
                                    <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                                  ) : (
                                    <Circle className="w-3 h-3 text-slate-400" />
                                  )}
                                  <span>{step.completed ? 'Done' : 'Mark Done'}</span>
                                </button>
                              </div>
                            </div>
                          );

                          const armColor = isSelected
                            ? 'border-sky-400'
                            : step.completed
                            ? 'border-emerald-500/55'
                            : isNextFocus
                            ? 'border-amber-400/60'
                            : 'border-slate-700';

                          const dotClass = step.completed
                            ? 'bg-emerald-400 border-emerald-300'
                            : isSelected
                            ? 'bg-sky-400 border-sky-200'
                            : isNextFocus
                            ? 'bg-amber-400 border-amber-200'
                            : 'bg-[#0B0F17] border-slate-500';

                          return (
                            <div
                              key={uidKey}
                              className="grid grid-cols-[24px_1fr] md:grid-cols-[1fr_44px_1fr] items-stretch"
                            >
                              {/* Desktop Left Branch */}
                              <div className="hidden md:flex items-center justify-end py-2">
                                {isLeft ? (
                                  <div className="w-full flex items-center justify-end">
                                    <div className="flex-1 max-w-full">{nodeCard}</div>
                                    <div
                                      className={`w-5 border-t-2 border-dashed shrink-0 ${armColor}`}
                                      aria-hidden="true"
                                    />
                                  </div>
                                ) : null}
                              </div>

                              {/* Center Progression Trunk & Junction Dot */}
                              <div className="flex flex-col items-center">
                                <div
                                  className={`w-0.5 flex-1 ${
                                    step.completed ? 'bg-emerald-500/50' : 'bg-slate-700'
                                  }`}
                                  aria-hidden="true"
                                />
                                <div
                                  className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${dotClass}`}
                                  aria-hidden="true"
                                />
                                <div
                                  className={`w-0.5 flex-1 ${
                                    isVeryLastNode
                                      ? 'bg-transparent'
                                      : step.completed
                                      ? 'bg-emerald-500/50'
                                      : 'bg-slate-700'
                                  }`}
                                  aria-hidden="true"
                                />
                              </div>

                              {/* Mobile Node (all steps) / Desktop Right Branch */}
                              <div className="flex items-center py-2">
                                {/* Mobile always renders card on right of left rail */}
                                <div className="flex items-center w-full md:hidden">
                                  <div
                                    className={`w-3 border-t-2 border-dashed shrink-0 ${armColor}`}
                                    aria-hidden="true"
                                  />
                                  <div className="flex-1 min-w-0">{nodeCard}</div>
                                </div>

                                {/* Desktop right branch only on odd steps */}
                                {!isLeft && (
                                  <div className="hidden md:flex items-center w-full">
                                    <div
                                      className={`w-5 border-t-2 border-dashed shrink-0 ${armColor}`}
                                      aria-hidden="true"
                                    />
                                    <div className="flex-1 min-w-0">{nodeCard}</div>
                                  </div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>

                      {/* Stage-to-Stage Vertical Connector */}
                      {!isLastStage && (
                        <div
                          className={`w-0.5 h-6 ${
                            stageComplete ? 'bg-emerald-500/50' : 'bg-slate-700'
                          }`}
                          aria-hidden="true"
                        />
                      )}
                    </div>
                  );
                })
                )}
              </section>

              {/* Right: Sticky Scrollable Detailed Step Inspector (Desktop) & Inline Fallback */}
              <aside
                ref={inspectorRef}
                aria-label="Step detail guide"
                className="lg:col-span-5 lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:flex lg:flex-col bg-[#121824] border border-sky-500/35 rounded-xl overflow-hidden scroll-mt-4"
              >
                {selectedEntry && selectedDetail ? (
                  <div className="flex flex-col flex-1 min-h-0">
                    {/* Inspector Header */}
                    <div className="shrink-0 px-4 sm:px-5 py-4 border-b border-slate-800/80 bg-[#0F1520] space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] font-mono tabular-nums">
                        <span className="text-sky-400 font-semibold">
                          {isAllMode ? 'PHASE' : 'STAGE'} {selectedEntry.stage.stageNumber} ·{' '}
                          {selectedEntry.sourceDomain.toUpperCase()} · STEP{' '}
                          {selectedEntry.stepCode} · {selectedEntry.stage.targetTier}
                        </span>
                        <div className="flex items-center gap-2.5">
                          <button
                            type="button"
                            onClick={() =>
                              graphRef.current?.scrollIntoView({
                                behavior: 'smooth',
                                block: 'start',
                              })
                            }
                            className="lg:hidden inline-flex items-center gap-1 text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
                          >
                            <ArrowUp className="w-3 h-3" />
                            <span>Back to Graph</span>
                          </button>
                          <span className="text-slate-400">
                            {selectedEntry.globalIndex + 1} / {flattenedSteps.length}
                          </span>
                        </div>
                      </div>

                      <h3 className="font-display text-base sm:text-lg font-semibold text-slate-50 leading-snug">
                        {selectedEntry.step.title}
                      </h3>

                      <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                        <span
                          className={
                            selectedEntry.step.completed
                              ? 'text-emerald-300'
                              : nextFocusStepId === selectedEntry.uidKey
                              ? 'text-amber-300'
                              : 'text-slate-300'
                          }
                        >
                          {selectedEntry.step.completed
                            ? 'Status: Completed'
                            : nextFocusStepId === selectedEntry.uidKey
                            ? 'Status: Next Recommended Focus'
                            : 'Status: Upcoming'}
                        </span>
                        {selectedDetail.linkedSkill && (
                          <>
                            <span className="text-slate-600">·</span>
                            <span className="text-sky-300 tabular-nums">
                              {selectedDetail.linkedSkill.title} ({selectedDetail.linkedSkill.mastery}%)
                            </span>
                          </>
                        )}
                        {isAllMode && (
                          <>
                            <span className="text-slate-600">·</span>
                            <button
                              type="button"
                              onClick={() => onSelectDomain(selectedEntry.sourceDomain)}
                              className="text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
                            >
                              Open {selectedEntry.sourceDomain} →
                            </button>
                          </>
                        )}
                      </div>

                      {selectedDetail.linkedSkill && (
                        <div className="w-full h-1.5 rounded-full bg-[#0B0F17] overflow-hidden border border-slate-800">
                          <div
                            className="h-full bg-sky-400 transition-all duration-300"
                            style={{ width: `${selectedDetail.linkedSkill.mastery}%` }}
                          />
                        </div>
                      )}
                    </div>

                    {/* Scrollable Inspector Body */}
                    <div
                      ref={inspectorBodyRef}
                      className="p-4 sm:p-5 space-y-5 lg:flex-1 lg:min-h-0 lg:overflow-y-auto overscroll-contain"
                    >
                      {selectedEntry.step.completedJobTaskTag && (
                        <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/40 text-xs text-emerald-200 font-mono">
                          Credited via Job Task: {selectedEntry.step.completedJobTaskTag}
                        </div>
                      )}

                      {/* Full Step Description */}
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-sky-400">
                          <BookOpen className="w-3.5 h-3.5" />
                          <span>Detailed Step Description</span>
                        </div>
                        <div className="space-y-2 text-xs sm:text-sm text-slate-200 leading-relaxed">
                          {selectedDetail.descriptionBlocks.map((para, idx) => (
                            <p key={idx}>{para}</p>
                          ))}
                        </div>
                      </div>

                      {/* Architecture & Implementation Deep Dive */}
                      <div className="space-y-2 pt-3 border-t border-slate-800/80">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[11px] font-mono uppercase tracking-wider text-slate-300 font-semibold">
                            Architecture &amp; Execution Guide
                          </span>
                          {!selectedDetail.hasNativeGuide && (
                            <button
                              type="button"
                              disabled={Boolean(designingDomain)}
                              onClick={() =>
                                void onDesignRoadmap(
                                  selectedEntry.sourceDomain,
                                  focusGoalInput.trim() || undefined
                                )
                              }
                              className="text-[11px] font-mono text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
                            >
                              Design full {selectedEntry.sourceDomain} AI guide →
                            </button>
                          )}
                        </div>
                        <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-slate-800/90 space-y-2 text-xs text-slate-300 leading-relaxed">
                          {selectedDetail.guideBlocks.map((block, idx) => (
                            <p key={idx}>{block}</p>
                          ))}
                        </div>
                      </div>

                      {/* Key Production Pitfalls */}
                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-amber-300">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Production Pitfalls to Avoid</span>
                        </div>
                        <ul className="space-y-1.5 p-3.5 rounded-lg bg-amber-950/20 border border-amber-500/30 text-xs text-amber-100/90">
                          {selectedDetail.pitfalls.map((pitfall, idx) => (
                            <li key={idx} className="leading-relaxed">
                              · {pitfall}
                            </li>
                          ))}
                        </ul>
                      </div>

                      {/* Concrete Deliverables */}
                      {selectedEntry.step.deliverables &&
                        selectedEntry.step.deliverables.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-slate-300">
                              <ListChecks className="w-3.5 h-3.5 text-emerald-400" />
                              <span>Concrete Deliverables</span>
                            </div>
                            <ul className="space-y-1.5 text-xs text-slate-300 pl-1">
                              {selectedEntry.step.deliverables.map((deliv, idx) => (
                                <li key={idx} className="flex items-start gap-2 leading-relaxed">
                                  <span className="font-mono text-sky-400 shrink-0">
                                    0{idx + 1}.
                                  </span>
                                  <span>{deliv}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                      {/* Verification Lab Objective */}
                      {selectedEntry.step.labObjective && (
                        <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-sky-500/30 space-y-1">
                          <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-sky-400">
                            <Target className="w-3.5 h-3.5" />
                            <span>Verification Lab Objective</span>
                          </div>
                          <p className="text-xs text-slate-200 leading-relaxed">
                            {selectedEntry.step.labObjective}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Pinned Action & Navigation Footer */}
                    <div className="shrink-0 px-4 sm:px-5 py-3.5 border-t border-slate-800/80 bg-[#0F1520] space-y-2.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          disabled={togglingStepId === selectedEntry.uidKey}
                          onClick={() => void handleToggleStep(selectedEntry.uidKey)}
                          className={`flex-1 inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] sm:min-h-0 py-2.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                            selectedEntry.step.completed
                              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25'
                              : 'bg-sky-500 hover:bg-sky-400 border-sky-400 text-slate-950'
                          }`}
                        >
                          {togglingStepId === selectedEntry.uidKey ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Saving...</span>
                            </>
                          ) : selectedEntry.step.completed ? (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Completed</span>
                            </>
                          ) : (
                            <>
                              <Circle className="w-3.5 h-3.5" />
                              <span>Mark Step Done</span>
                            </>
                          )}
                        </button>

                        {onAskJarvis && (
                          <button
                            type="button"
                            onClick={() =>
                              onAskJarvis(
                                `Coach me in detail on ${selectedEntry.sourceDomain} roadmap step ${selectedEntry.stepCode} "${selectedEntry.step.title}" (linked skill: ${selectedEntry.step.skillTitle}). Explain internals, pitfalls, and walk me through verifying the lab objective.`
                              )
                            }
                            className="inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[44px] sm:min-h-0 py-2.5 rounded-lg border border-slate-700/80 bg-[#0B0F17] hover:bg-slate-800 text-xs font-medium text-sky-300 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <Bot className="w-3.5 h-3.5" />
                            <span>Coach Step</span>
                          </button>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
                        <button
                          type="button"
                          disabled={!prevEntry}
                          onClick={() => prevEntry && setSelectedStepId(prevEntry.uidKey)}
                          className="min-h-[38px] px-1 inline-flex items-center gap-1.5 text-xs font-mono text-slate-300 hover:text-sky-300 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                          <span>{prevEntry ? `Step ${prevEntry.stepCode}` : 'Start'}</span>
                        </button>

                        <button
                          type="button"
                          disabled={!nextEntry}
                          onClick={() => nextEntry && setSelectedStepId(nextEntry.uidKey)}
                          className="min-h-[38px] px-1 inline-flex items-center gap-1.5 text-xs font-mono text-slate-300 hover:text-sky-300 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                        >
                          <span>{nextEntry ? `Step ${nextEntry.stepCode}` : 'End'}</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="p-6 text-xs text-slate-400">
                    Select any topic node on the roadmap graph to inspect its detailed architecture
                    guide, deliverables, and verification lab.
                  </div>
                )}
              </aside>

              {/* Mobile / Tablet Scrollable Step Detail Sheet (opens when tapping a node card < lg) */}
              {mobileInspectorOpen && selectedEntry && selectedDetail && (
                <div
                  className="lg:hidden fixed inset-0 z-50 flex flex-col justify-end bg-black/75 backdrop-blur-[2px]"
                  role="dialog"
                  aria-modal="true"
                  aria-label="Step detail guide"
                >
                  <div
                    className="flex-1 min-h-8"
                    onClick={() => setMobileInspectorOpen(false)}
                    aria-hidden="true"
                  />
                  <div className="w-full max-h-[90dvh] bg-[#121824] border-t border-sky-500/45 rounded-t-2xl flex flex-col overflow-hidden shadow-2xl">
                    {/* Sheet Header */}
                    <div className="shrink-0 px-4 py-3.5 border-b border-slate-800/80 bg-[#0F1520] flex items-start justify-between gap-3">
                      <div className="space-y-1 min-w-0">
                        <div className="text-[11px] font-mono text-sky-400 font-semibold tabular-nums">
                          {isAllMode ? 'PHASE' : 'STAGE'} {selectedEntry.stage.stageNumber} ·{' '}
                          {selectedEntry.sourceDomain.toUpperCase()} · STEP{' '}
                          {selectedEntry.stepCode} ({selectedEntry.globalIndex + 1}/
                          {flattenedSteps.length})
                        </div>
                        <h3 className="font-display text-base font-semibold text-slate-50 leading-snug">
                          {selectedEntry.step.title}
                        </h3>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono">
                          <span
                            className={
                              selectedEntry.step.completed
                                ? 'text-emerald-300'
                                : nextFocusStepId === selectedEntry.uidKey
                                ? 'text-amber-300'
                                : 'text-slate-300'
                            }
                          >
                            {selectedEntry.step.completed
                              ? 'Completed'
                              : nextFocusStepId === selectedEntry.uidKey
                              ? 'Next Focus'
                              : 'Upcoming'}
                          </span>
                          {selectedDetail.linkedSkill && (
                            <>
                              <span className="text-slate-600">·</span>
                              <span className="text-sky-300 tabular-nums">
                                {selectedDetail.linkedSkill.mastery}% mastery
                              </span>
                            </>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setMobileInspectorOpen(false)}
                        aria-label="Close step detail"
                        className="min-w-[40px] min-h-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer shrink-0"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    {/* Touch-Scrollable Sheet Body */}
                    <div
                      ref={mobileInspectorBodyRef}
                      className="flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-5"
                    >
                      {selectedEntry.step.completedJobTaskTag && (
                        <div className="p-3 rounded-lg bg-emerald-950/30 border border-emerald-500/40 text-xs text-emerald-200 font-mono">
                          Credited via Job Task: {selectedEntry.step.completedJobTaskTag}
                        </div>
                      )}

                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-sky-400">
                          <BookOpen className="w-3.5 h-3.5" />
                          <span>Detailed Step Description</span>
                        </div>
                        <div className="space-y-2 text-sm text-slate-200 leading-relaxed">
                          {selectedDetail.descriptionBlocks.map((para, idx) => (
                            <p key={idx}>{para}</p>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2 pt-3 border-t border-slate-800/80">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-[11px] font-mono uppercase tracking-wider text-slate-300 font-semibold">
                            Architecture &amp; Execution Guide
                          </span>
                          {!selectedDetail.hasNativeGuide && (
                            <button
                              type="button"
                              disabled={Boolean(designingDomain)}
                              onClick={() =>
                                void onDesignRoadmap(
                                  selectedEntry.sourceDomain,
                                  focusGoalInput.trim() || undefined
                                )
                              }
                              className="text-[11px] font-mono text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
                            >
                              Design {selectedEntry.sourceDomain} AI guide →
                            </button>
                          )}
                        </div>
                        <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-slate-800/90 space-y-2 text-xs text-slate-300 leading-relaxed">
                          {selectedDetail.guideBlocks.map((block, idx) => (
                            <p key={idx}>{block}</p>
                          ))}
                        </div>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-amber-300">
                          <AlertTriangle className="w-3.5 h-3.5" />
                          <span>Production Pitfalls to Avoid</span>
                        </div>
                        <ul className="space-y-1.5 p-3.5 rounded-lg bg-amber-950/20 border border-amber-500/30 text-xs text-amber-100/90">
                          {selectedDetail.pitfalls.map((pitfall, idx) => (
                            <li key={idx} className="leading-relaxed">
                              · {pitfall}
                            </li>
                          ))}
                        </ul>
                      </div>

                      {selectedEntry.step.deliverables &&
                        selectedEntry.step.deliverables.length > 0 && (
                          <div className="space-y-2">
                            <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-slate-300">
                              <ListChecks className="w-3.5 h-3.5 text-emerald-400" />
                              <span>Concrete Deliverables</span>
                            </div>
                            <ul className="space-y-1.5 text-xs text-slate-300 pl-1">
                              {selectedEntry.step.deliverables.map((deliv, idx) => (
                                <li key={idx} className="flex items-start gap-2 leading-relaxed">
                                  <span className="font-mono text-sky-400 shrink-0">
                                    0{idx + 1}.
                                  </span>
                                  <span>{deliv}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                      {selectedEntry.step.labObjective && (
                        <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-sky-500/30 space-y-1">
                          <div className="flex items-center gap-1.5 text-[11px] font-mono uppercase tracking-wider text-sky-400">
                            <Target className="w-3.5 h-3.5" />
                            <span>Verification Lab Objective</span>
                          </div>
                          <p className="text-xs text-slate-200 leading-relaxed">
                            {selectedEntry.step.labObjective}
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Pinned Mobile Sheet Footer */}
                    <div className="shrink-0 px-4 py-3 pb-[max(0.875rem,env(safe-area-inset-bottom))] border-t border-slate-800/80 bg-[#0F1520] space-y-2">
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={togglingStepId === selectedEntry.uidKey}
                          onClick={() => void handleToggleStep(selectedEntry.uidKey)}
                          className={`flex-1 inline-flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
                            selectedEntry.step.completed
                              ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200'
                              : 'bg-sky-500 hover:bg-sky-400 border-sky-400 text-slate-950'
                          }`}
                        >
                          {togglingStepId === selectedEntry.uidKey ? (
                            <>
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              <span>Saving...</span>
                            </>
                          ) : selectedEntry.step.completed ? (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Completed</span>
                            </>
                          ) : (
                            <>
                              <Circle className="w-3.5 h-3.5" />
                              <span>Mark Step Done</span>
                            </>
                          )}
                        </button>

                        {onAskJarvis && (
                          <button
                            type="button"
                            onClick={() => {
                              setMobileInspectorOpen(false);
                              onAskJarvis(
                                `Coach me in detail on ${selectedEntry.sourceDomain} roadmap step ${selectedEntry.stepCode} "${selectedEntry.step.title}" (linked skill: ${selectedEntry.step.skillTitle}). Explain internals, pitfalls, and walk me through verifying the lab objective.`
                              );
                            }}
                            className="inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[44px] rounded-lg border border-slate-700/80 bg-[#0B0F17] hover:bg-slate-800 text-xs font-medium text-sky-300 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                          >
                            <Bot className="w-3.5 h-3.5" />
                            <span>Coach</span>
                          </button>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-800/60">
                        <button
                          type="button"
                          disabled={!prevEntry}
                          onClick={() => prevEntry && setSelectedStepId(prevEntry.uidKey)}
                          className="min-h-[40px] px-1 inline-flex items-center gap-1.5 text-xs font-mono text-slate-300 hover:text-sky-300 disabled:opacity-35 cursor-pointer whitespace-nowrap"
                        >
                          <ArrowLeft className="w-3.5 h-3.5" />
                          <span>{prevEntry ? `Step ${prevEntry.stepCode}` : 'Start'}</span>
                        </button>

                        <button
                          type="button"
                          disabled={!nextEntry}
                          onClick={() => nextEntry && setSelectedStepId(nextEntry.uidKey)}
                          className="min-h-[40px] px-1 inline-flex items-center gap-1.5 text-xs font-mono text-slate-300 hover:text-sky-300 disabled:opacity-35 disabled:cursor-not-allowed cursor-pointer whitespace-nowrap"
                        >
                          <span>{nextEntry ? `Step ${nextEntry.stepCode}` : 'End'}</span>
                          <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ) : (
            /* Detailed Linear List View (Filtered Stages Expanded with Full Descriptions) */
            <div className="space-y-5">
              {filteredStages.length === 0 ? (
                <div className="bg-[#121824] border border-slate-800/80 rounded-xl p-8 text-center space-y-3">
                  <p className="text-xs text-slate-400">
                    No steps match the &ldquo;{stepFilter}&rdquo; filter on{' '}
                    {isAllMode ? 'Unified Sequence' : selectedDomain}.
                  </p>
                  <button
                    type="button"
                    onClick={() => setStepFilter('all')}
                    className="px-3.5 py-1.5 rounded-lg border border-slate-700 bg-[#0B0F17] hover:border-sky-400 text-xs text-sky-300 cursor-pointer"
                  >
                    Show all steps
                  </button>
                </div>
              ) : (
                filteredStages.map((stage) => {
                  const sourceStage =
                    activeStages.find((st) => st.stageKey === stage.stageKey) || stage;
                  const stageDoneCount = sourceStage.steps.filter(
                    (item) => item.step.completed
                  ).length;
                  const stageTotalCount = sourceStage.steps.length;
                  const stageComplete =
                    stageTotalCount > 0 && stageDoneCount === stageTotalCount;

                  return (
                    <section
                      key={stage.stageKey}
                      className={`bg-[#121824] border rounded-xl overflow-hidden ${
                        stageComplete ? 'border-emerald-500/40' : 'border-slate-800/80'
                      }`}
                    >
                      <div className="px-6 py-4 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3 bg-[#0F1520]">
                        <div className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                            <span className="text-sky-400 font-semibold">
                              {isAllMode
                                ? `PHASE ${String(stage.stageNumber).padStart(2, '0')} · ${stage.domain.toUpperCase()}`
                                : `STAGE ${stage.stageNumber}`}
                            </span>
                            <span className="text-slate-600">·</span>
                            <span
                              className={
                                stage.targetTier === 'Top 1%'
                                  ? 'text-amber-300'
                                  : stage.targetTier === 'Senior'
                                  ? 'text-sky-300'
                                  : 'text-slate-300'
                              }
                            >
                              {stage.targetTier}
                            </span>
                            {isAllMode && stage.sourceType === 'skill' && (
                              <>
                                <span className="text-slate-600">·</span>
                                <span className="text-slate-400">Curriculum Seed</span>
                              </>
                            )}
                          </div>
                          <h3 className="font-display text-base font-semibold text-slate-50">
                            {stage.title}
                          </h3>
                          {stage.milestoneGoal && (
                            <p className="text-xs text-slate-400">{stage.milestoneGoal}</p>
                          )}
                        </div>

                        <div className="font-mono text-xs tabular-nums px-3 py-1.5 rounded-lg bg-[#0B0F17] border border-slate-800 text-slate-200">
                          {stageDoneCount} / {stageTotalCount} steps done
                        </div>
                      </div>

                      <div className="divide-y divide-slate-800/60">
                        {stage.steps.map((item, sIdx) => {
                          const { step, uidKey, sourceDomain } = item;
                          const detail = buildStepDetailContent(step, sourceDomain);
                          const isBusy = togglingStepId === uidKey;
                          const stepCode =
                            stepCodeById.get(uidKey) || `${stage.stageNumber}.${sIdx + 1}`;

                        return (
                          <div
                            key={uidKey}
                            className={`p-5 sm:px-6 space-y-3.5 transition-colors ${
                              step.completed ? 'bg-emerald-500/[0.03]' : 'hover:bg-slate-800/20'
                            }`}
                          >
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div className="space-y-1 min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2 text-[11px] font-mono text-slate-400">
                                  <span className="text-slate-300 font-semibold">
                                    Step {stepCode}
                                  </span>
                                  {isAllMode && (
                                    <>
                                      <span className="text-slate-600">·</span>
                                      <span className="text-amber-300 font-semibold">
                                        {sourceDomain}
                                      </span>
                                    </>
                                  )}
                                  <span className="text-slate-600">·</span>
                                  <span className="text-sky-300">
                                    Skill: {step.skillTitle}
                                  </span>
                                  {detail.linkedSkill && (
                                    <>
                                      <span className="text-slate-600">·</span>
                                      <span className="text-emerald-300 tabular-nums">
                                        Node Mastery {detail.linkedSkill.mastery}%
                                      </span>
                                    </>
                                  )}
                                  {step.completedJobTaskTag && (
                                    <>
                                      <span className="text-slate-600">·</span>
                                      <span className="text-amber-300">
                                        Done via Job: {step.completedJobTaskTag}
                                      </span>
                                    </>
                                  )}
                                </div>

                                <h4
                                  className={`text-sm font-semibold ${
                                    step.completed ? 'text-slate-300' : 'text-slate-50'
                                  }`}
                                >
                                  {step.title}
                                </h4>
                              </div>

                              <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto shrink-0">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedStepId(uidKey);
                                    setViewMode('graph');
                                  }}
                                  className="inline-flex items-center justify-center gap-1.5 px-3 min-h-[38px] sm:min-h-0 py-1.5 rounded-lg border border-slate-700/80 bg-[#0B0F17] hover:bg-slate-800 text-xs font-medium text-slate-200 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                                >
                                  <GitBranch className="w-3.5 h-3.5 text-sky-400" />
                                  <span>View in Graph</span>
                                </button>

                                {onAskJarvis && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      onAskJarvis(
                                        `Coach me on my ${sourceDomain} roadmap step "${step.title}" (linked skill: ${step.skillTitle}). Give me exact production internals and how to verify the lab objective.`
                                      )
                                    }
                                    className="inline-flex items-center justify-center gap-1.5 px-3 min-h-[38px] sm:min-h-0 py-1.5 rounded-lg border border-slate-700/80 bg-[#0B0F17] hover:bg-slate-800 text-xs font-medium text-sky-300 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                                  >
                                    <Bot className="w-3.5 h-3.5" />
                                    <span>Coach Step</span>
                                  </button>
                                )}

                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => void handleToggleStep(uidKey)}
                                  className={`flex-1 sm:flex-initial inline-flex items-center justify-center gap-1.5 px-3.5 min-h-[38px] sm:min-h-0 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                                    step.completed
                                      ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-200 hover:bg-emerald-500/25'
                                      : 'bg-sky-500 hover:bg-sky-400 border-sky-400 text-slate-950'
                                  }`}
                                >
                                  {isBusy ? (
                                    <>
                                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                      <span>Saving...</span>
                                    </>
                                  ) : step.completed ? (
                                    <>
                                      <CheckCircle2 className="w-3.5 h-3.5" />
                                      <span>Done</span>
                                    </>
                                  ) : (
                                    <>
                                      <Circle className="w-3.5 h-3.5" />
                                      <span>Mark Done</span>
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>

                            <div className="space-y-1.5 text-xs text-slate-200 leading-relaxed">
                              {detail.descriptionBlocks.map((para, idx) => (
                                <p key={idx}>{para}</p>
                              ))}
                            </div>

                            <div className="p-3.5 rounded-lg bg-[#0B0F17] border border-slate-800/80 space-y-1.5 text-xs text-slate-300 leading-relaxed">
                              <div className="text-[11px] font-mono uppercase tracking-wider text-sky-400">
                                Architecture &amp; Execution Guide
                              </div>
                              {detail.guideBlocks.map((block, idx) => (
                                <p key={idx}>{block}</p>
                              ))}
                            </div>

                            {detail.pitfalls.length > 0 && (
                              <div className="p-3 rounded-lg bg-amber-950/20 border border-amber-500/30 space-y-1 text-xs text-amber-100/90">
                                <div className="text-[11px] font-mono uppercase tracking-wider text-amber-300">
                                  Production Pitfalls
                                </div>
                                {detail.pitfalls.map((p, idx) => (
                                  <p key={idx}>· {p}</p>
                                ))}
                              </div>
                            )}

                            {step.deliverables && step.deliverables.length > 0 && (
                              <ul className="space-y-1 text-xs text-slate-300 pl-3 border-l border-slate-800">
                                {step.deliverables.map((deliv, dIdx) => (
                                  <li key={dIdx}>{deliv}</li>
                                ))}
                              </ul>
                            )}

                            {step.labObjective && (
                              <div className="p-3 rounded-lg bg-[#0B0F17] border border-slate-800/80 flex items-start gap-2 text-xs text-slate-300">
                                <Target className="w-3.5 h-3.5 text-sky-400 shrink-0 mt-0.5" />
                                <div>
                                  <span className="font-mono text-[11px] uppercase tracking-wider text-sky-400 mr-2">
                                    Verification Lab:
                                  </span>
                                  <span>{step.labObjective}</span>
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </section>
                );
              })
              )}
            </div>
          )}
        </div>
      )}

      {/* Completed Job Tasks & Engineering Logs */}
      <section className="bg-[#121824] border border-slate-800/80 rounded-xl overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-display text-sm font-semibold text-slate-100">
              {isAllMode
                ? 'All-Domain Completed Job Tasks & Engineering Logs'
                : `${selectedDomain} Completed Job Tasks & Engineering Logs`}
            </h3>
            <p className="text-xs text-slate-400">
              Job tasks marked complete credit both domain level and roadmap progression
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              onNavigate('profile', isAllMode ? undefined : selectedDomain)
            }
            className="text-xs text-sky-400 hover:text-sky-300 cursor-pointer whitespace-nowrap"
          >
            Inspect {isAllMode ? 'Full' : selectedDomain} Syllabus →
          </button>
        </div>

        {domainWorkLogs.length === 0 &&
        domainCompletedMissions.length === 0 &&
        (!currentRoadmap?.completedJobTasks || currentRoadmap.completedJobTasks.length === 0) ? (
          <div className="p-6 text-xs text-slate-400">
            No {isAllMode ? 'engineering' : selectedDomain} job tasks recorded yet. Use
            &ldquo;Mark Prior Job Done &amp; Resume Path&rdquo; above or upload a sprint task to
            log production experience.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/60">
            {domainWorkLogs.map((log) => (
              <div key={log.id} className="px-6 py-4 flex flex-wrap items-start justify-between gap-3">
                <div className="space-y-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    <span className="text-xs font-semibold text-slate-100">
                      {log.projectName}
                    </span>
                    {isAllMode && (
                      <span className="font-mono text-[11px] text-sky-400">
                        · {log.primaryDomain}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400">{log.taskSummary}</p>
                  {log.elevationNote && (
                    <p className="text-[11px] font-mono text-sky-300/90">{log.elevationNote}</p>
                  )}
                </div>
                <div className="font-mono text-xs text-emerald-400 tabular-nums shrink-0">
                  +{log.xpAwarded} XP · {log.minutesSpent}m
                </div>
              </div>
            ))}

            {domainCompletedMissions
              .filter(
                (m) =>
                  !domainWorkLogs.some(
                    (l) => l.projectName.toLowerCase() === m.projectName.toLowerCase()
                  )
              )
              .map((m) => (
                <div
                  key={m.id}
                  className="px-6 py-4 flex items-center justify-between gap-3"
                >
                  <div className="space-y-0.5 min-w-0">
                    <div className="text-xs font-semibold text-slate-100 truncate">
                      {m.projectName}
                    </div>
                    <div className="text-xs text-slate-400 truncate">{m.masteryGoal}</div>
                  </div>
                  <span className="font-mono text-xs text-emerald-400 shrink-0">
                    Mission Complete
                  </span>
                </div>
              ))}
          </div>
        )}
      </section>
    </div>
  );
};
