import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { onAuthStateChanged, signOut, type User } from 'firebase/auth';
import { Map, Swords, Upload, User as UserIcon } from 'lucide-react';
import { ActiveRecallDrawer } from './components/ActiveRecallDrawer';
import { AuthGate } from './components/AuthGate';
import { CalibrationView } from './components/CalibrationView';
import { CelebrationOverlay, type CelebrationEvent } from './components/CelebrationOverlay';
import { JarvisConsole } from './components/JarvisConsole';
import { ProfilePage } from './components/ProfilePage';
import { QuestsPage } from './components/QuestsPage';
import { RoadmapsPage } from './components/RoadmapsPage';
import { UploadTaskPage } from './components/UploadTaskPage';
import { DOMAINS } from './data/seedCurriculum';
import {
  askJarvisWithAi,
  designRoadmapWithAi,
  generateDailyQuestsWithSystemAi,
  generateStudyBriefWithAi,
  mapWorkLogWithAi,
} from './lib/aiClient';
import { computeMilestones } from './data/milestones';
import { auth } from './lib/firebase';
import {
  applyJarvisSyllabusStructure,
  awardSkillPracticeFromJarvis,
  completeDailyQuestAtomic,
  ensureUserWorkspace,
  getTodayDayKey,
  getTodayIsoDate,
  markJobTaskDoneAndResumePath,
  saveDomainRoadmap,
  saveGeneratedDailyQuests,
  saveJarvisThread,
  saveSkillBrief,
  subscribeDailyQuests,
  subscribeDomainRoadmaps,
  subscribeJarvisThread,
  subscribeProjectMissions,
  subscribeReviewCards,
  subscribeSkills,
  subscribeUserProfile,
  subscribeWorkLogs,
} from './lib/firestoreService';
import type {
  DailyQuest,
  Domain,
  DomainRoadmap,
  JarvisAction,
  JarvisMessage,
  JarvisTrigger,
  ProjectMission,
  ReviewCard,
  SimplePage,
  SkillNode,
  SystemUploadProjectResult,
  UserProfile,
  WorkLog,
} from './types/learning';

const NAV_ITEMS: Array<{
  id: SimplePage;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: 'quests', label: 'Quests', icon: Swords },
  { id: 'roadmaps', label: 'Roadmaps', icon: Map },
  { id: 'upload', label: 'Upload Task', icon: Upload },
  { id: 'profile', label: 'Profile', icon: UserIcon },
];

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);

  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [skills, setSkills] = useState<SkillNode[]>([]);
  const [workLogs, setWorkLogs] = useState<WorkLog[]>([]);
  const [projectMissions, setProjectMissions] = useState<ProjectMission[]>([]);
  const [dailyQuests, setDailyQuests] = useState<DailyQuest[]>([]);
  const [domainRoadmaps, setDomainRoadmaps] = useState<Partial<Record<Domain, DomainRoadmap>>>({});
  const [reviewCards, setReviewCards] = useState<ReviewCard[]>([]);
  const [recallOpen, setRecallOpen] = useState(false);
  const [missionsSynced, setMissionsSynced] = useState(false);
  const [questsSynced, setQuestsSynced] = useState(false);
  const [autoGeneratingQuests, setAutoGeneratingQuests] = useState(false);
  const autoQuestAttemptRef = useRef<string | null>(null);

  const [workspaceReady, setWorkspaceReady] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  const [activePage, setActivePage] = useState<SimplePage>('quests');
  const [profileDomainFilter, setProfileDomainFilter] = useState<Domain | 'All'>('All');
  const [roadmapDomain, setRoadmapDomain] = useState<Domain | 'All'>('All');
  const [designingRoadmapDomain, setDesigningRoadmapDomain] = useState<Domain | 'All' | null>(null);
  const [designingRoadmapProgress, setDesigningRoadmapProgress] = useState<{
    current: number;
    total: number;
    domain: Domain;
  } | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [focusedQuestId, setFocusedQuestId] = useState<string | null>(null);
  const [celebration, setCelebration] = useState<CelebrationEvent | null>(null);
  const [systemNotice, setSystemNotice] = useState<string | null>(null);

  // JARVIS command mentor state
  const [jarvisOpen, setJarvisOpen] = useState(false);
  const [jarvisLoading, setJarvisLoading] = useState(false);
  const [jarvisMessages, setJarvisMessages] = useState<JarvisMessage[]>([]);
  const [jarvisThreadSynced, setJarvisThreadSynced] = useState(false);
  const [prefilledUpload, setPrefilledUpload] = useState<{
    projectName?: string;
    rawTaskBrief?: string;
    nonce: number;
  } | null>(null);
  const proactiveScanUserRef = useRef<string | null>(null);
  const jarvisThreadExistsRef = useRef(false);
  const jarvisHydratedRef = useRef(false);
  const jarvisMessagesRef = useRef<JarvisMessage[]>([]);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setProfile(null);
        setSkills([]);
        setWorkLogs([]);
        setProjectMissions([]);
        setDailyQuests([]);
        setDomainRoadmaps({});
        setReviewCards([]);
        setRecallOpen(false);
        setMissionsSynced(false);
        setQuestsSynced(false);
        setJarvisThreadSynced(false);
        autoQuestAttemptRef.current = null;
        proactiveScanUserRef.current = null;
        jarvisThreadExistsRef.current = false;
        jarvisHydratedRef.current = false;
        jarvisMessagesRef.current = [];
        setWorkspaceReady(false);
        setJarvisMessages([]);
        setJarvisOpen(false);
        setPrefilledUpload(null);
        setSelectedSkillId(null);
        setFocusedQuestId(null);
        setDesigningRoadmapDomain(null);
        setDesigningRoadmapProgress(null);
        setRoadmapDomain('All');
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!authReady || !user) return;

    let active = true;
    const unsubs: Array<() => void> = [];

    async function init() {
      if (!user) return;
      try {
        await ensureUserWorkspace(user.uid, user.displayName || user.email || 'Engineer');
        if (!active) return;

        // Subscribe only to active collections to keep Firestore free-tier usage minimal
        unsubs.push(
          subscribeUserProfile(user.uid, (p) => {
            setProfile(p);
            setWorkspaceReady(true);
          }),
          subscribeSkills(user.uid, setSkills),
          subscribeWorkLogs(user.uid, setWorkLogs),
          subscribeProjectMissions(user.uid, (rows) => {
            setProjectMissions(rows);
            setMissionsSynced(true);
          }),
          subscribeDailyQuests(user.uid, (rows) => {
            setDailyQuests(rows);
            setQuestsSynced(true);
          }),
          subscribeDomainRoadmaps(user.uid, setDomainRoadmaps),
          subscribeReviewCards(user.uid, setReviewCards),
          subscribeJarvisThread(user.uid, (msgs, existsInDb) => {
            jarvisThreadExistsRef.current = existsInDb;
            if (!jarvisHydratedRef.current) {
              jarvisHydratedRef.current = true;
              if (msgs.length > 0) {
                jarvisMessagesRef.current = msgs;
                setJarvisMessages(msgs);
              }
              setJarvisThreadSynced(true);
            }
          })
        );
      } catch (err) {
        if (active) {
          setBootError(err instanceof Error ? err.message : 'Failed to initialize workspace.');
        }
      }
    }

    void init();

    return () => {
      active = false;
      unsubs.forEach((fn) => fn());
    };
  }, [authReady, user]);

  const activeProject = useMemo(
    () => projectMissions.find((m) => m.status === 'active') || null,
    [projectMissions]
  );

  const todayKey = getTodayIsoDate();

  const todayQuests = useMemo(
    () => dailyQuests.filter((q) => q.dateKey === todayKey),
    [dailyQuests, todayKey]
  );

  const pendingTodayQuestsCount = useMemo(
    () => todayQuests.filter((q) => q.status === 'pending').length,
    [todayQuests]
  );

  const selectedSkillTitle = useMemo(
    () => skills.find((s) => s.id === selectedSkillId)?.title || null,
    [skills, selectedSkillId]
  );

  const dueCardsCount = useMemo(() => {
    const nowIso = new Date().toISOString();
    return reviewCards.filter((c) => !c.nextReviewAt || c.nextReviewAt <= nowIso).length;
  }, [reviewCards]);

  // Automatically issue today's daily quests when calibrated and none exist for today
  useEffect(() => {
    if (
      !workspaceReady ||
      !profile?.calibrated ||
      !missionsSynced ||
      !questsSynced ||
      skills.length === 0 ||
      autoGeneratingQuests
    ) {
      return;
    }

    if (todayQuests.length > 0) return;

    const mode = activeProject ? 'project_override' : 'normal_routine';
    const attemptKey = `${profile.userId}-${todayKey}-${mode}-${activeProject?.id || 'normal'}`;
    if (autoQuestAttemptRef.current === attemptKey) return;

    autoQuestAttemptRef.current = attemptKey;
    setAutoGeneratingQuests(true);

    const todaySlot = profile.rotationMap[getTodayDayKey()];
    generateDailyQuestsWithSystemAi({
      dateKey: todayKey,
      todaySlot,
      mode,
      activeProject,
      skills,
      recentWorkLogs: workLogs,
      domainFocusMinutes: profile.domainFocusMinutes,
      dueCardsCount,
      weeklyHoursTarget: profile.weeklyHoursTarget,
    })
      .then((res) => {
        if (res.aiNotice) {
          setSystemNotice(res.aiNotice);
        }
        return saveGeneratedDailyQuests(
          profile.userId,
          todayKey,
          mode,
          activeProject,
          [],
          res.dailyQuests
        );
      })
      .catch((err) => {
        console.error('Auto daily quest generation failed:', err);
        setSystemNotice(
          err instanceof Error ? err.message : 'Unable to automatically generate daily quests.'
        );
      })
      .finally(() => {
        setAutoGeneratingQuests(false);
      });
  }, [
    workspaceReady,
    profile,
    missionsSynced,
    questsSynced,
    skills,
    todayQuests,
    activeProject,
    workLogs,
    dueCardsCount,
    autoGeneratingQuests,
    todayKey,
  ]);

  const handleNavigate = useCallback((page: SimplePage, domainFilter?: Domain | 'All') => {
    if (page === 'profile') {
      setProfileDomainFilter(domainFilter || 'All');
    } else {
      setSelectedSkillId(null);
      if (page === 'roadmaps' && domainFilter) {
        setRoadmapDomain(domainFilter);
      }
    }
    setActivePage(page);
  }, []);

  const refreshDailyQuestsFromJarvis = useCallback(async () => {
    if (!profile || autoGeneratingQuests) return;
    setAutoGeneratingQuests(true);
    try {
      const mode = activeProject ? 'project_override' : 'normal_routine';
      const todaySlot = profile.rotationMap[getTodayDayKey()];
      const generated = await generateDailyQuestsWithSystemAi({
        dateKey: todayKey,
        todaySlot,
        mode,
        activeProject,
        skills,
        recentWorkLogs: workLogs,
        domainFocusMinutes: profile.domainFocusMinutes,
        dueCardsCount,
        weeklyHoursTarget: profile.weeklyHoursTarget,
      });
      if (generated.aiNotice) {
        setSystemNotice(generated.aiNotice);
      }
      const pendingToday = todayQuests.filter((q) => q.status === 'pending');
      await saveGeneratedDailyQuests(
        profile.userId,
        todayKey,
        mode,
        activeProject,
        pendingToday,
        generated.dailyQuests
      );
    } catch (err) {
      setSystemNotice(
        err instanceof Error ? err.message : 'Unable to refresh daily quests.'
      );
    } finally {
      setAutoGeneratingQuests(false);
    }
  }, [
    profile,
    autoGeneratingQuests,
    activeProject,
    todayKey,
    skills,
    workLogs,
    dueCardsCount,
    todayQuests,
  ]);

  const completeQuestFromJarvis = useCallback(
    async (quest: DailyQuest) => {
      if (!profile || quest.status === 'completed') return;
      try {
        const beforeUnlocked = new Set(
          computeMilestones({
            profile,
            skills,
            missions: projectMissions,
            quests: dailyQuests,
            todayKey,
          })
            .filter((m) => m.unlocked)
            .map((m) => m.id)
        );

        const { roadmapStepSynced } = await completeDailyQuestAtomic(
          profile.userId,
          profile,
          skills,
          quest,
          domainRoadmaps[quest.domain] || null
        );

        const simulatedQuests = dailyQuests.map((q) =>
          q.id === quest.id ? { ...q, status: 'completed' as const } : q
        );
        const afterMilestones = computeMilestones({
          profile,
          skills,
          missions: projectMissions,
          quests: simulatedQuests,
          todayKey,
        });
        const newlyUnlocked = afterMilestones
          .filter((m) => m.unlocked && !beforeUnlocked.has(m.id))
          .map((m) => m.title);

        const nextPending = todayQuests.find(
          (q) => q.id !== quest.id && q.status === 'pending'
        );
        setFocusedQuestId(nextPending ? nextPending.id : null);

        setCelebration({
          kind: 'quest',
          title: `${quest.title} Cleared`,
          subtitle: roadmapStepSynced
            ? `JARVIS verified quest completion. +${quest.xpReward} XP, ${quest.domain} mastery boosted, and synced roadmap step "${roadmapStepSynced}".`
            : `JARVIS verified quest completion. +${quest.xpReward} XP and ${quest.domain} mastery boosted.`,
          xpAwarded: quest.xpReward,
          domain: quest.domain,
          unlockedMilestones: newlyUnlocked,
        });
      } catch (err) {
        setSystemNotice(
          err instanceof Error ? err.message : 'Unable to complete quest via JARVIS.'
        );
      }
    },
    [profile, skills, projectMissions, dailyQuests, todayKey, todayQuests, domainRoadmaps]
  );

  const refreshSkillBriefFromJarvis = useCallback(
    async (skill: SkillNode) => {
      if (!profile) return;
      try {
        const res = await generateStudyBriefWithAi({
          domain: skill.domain,
          title: skill.title,
          tier: skill.tier,
          description: skill.description,
        });
        await saveSkillBrief(profile.userId, skill.id, res.studyBrief, res.labPrompt);
      } catch (err) {
        setSystemNotice(
          err instanceof Error ? err.message : 'Unable to refresh study brief.'
        );
      }
    },
    [profile]
  );

  const structureSyllabusFromJarvis = useCallback(
    async (plan: Extract<JarvisAction, { type: 'structure_syllabus' }>) => {
      if (!profile) return;
      try {
        await applyJarvisSyllabusStructure(profile.userId, skills, plan);
      } catch (err) {
        setSystemNotice(
          err instanceof Error ? err.message : 'Unable to apply JARVIS syllabus structure.'
        );
      }
    },
    [profile, skills]
  );

  const handleDesignRoadmap = useCallback(
    async (
      domain: Domain | 'All',
      focusGoal?: string,
      opts?: { onlyMissing?: boolean }
    ) => {
      if (!profile || designingRoadmapDomain) return;
      const targetDomains: Domain[] =
        domain === 'All'
          ? opts?.onlyMissing
            ? DOMAINS.filter((d) => !domainRoadmaps[d])
            : [...DOMAINS]
          : [domain];

      if (targetDomains.length === 0) {
        setSystemNotice('All 5 domain roadmaps are already designed by JARVIS.');
        return;
      }

      setDesigningRoadmapDomain(domain);
      try {
        const completedMissions = projectMissions.filter((m) => m.status === 'completed');
        let latestNotice: string | undefined;

        for (let idx = 0; idx < targetDomains.length; idx += 1) {
          const d = targetDomains[idx];
          if (domain === 'All') {
            setDesigningRoadmapProgress({
              current: idx + 1,
              total: targetDomains.length,
              domain: d,
            });
          }
          const res = await designRoadmapWithAi({
            domain: d,
            focusGoal,
            skills,
            workLogs,
            completedMissions,
            existingRoadmap: domainRoadmaps[d] || null,
          });
          await saveDomainRoadmap(
            profile.userId,
            res.roadmap,
            skills,
            Boolean(domainRoadmaps[d])
          );
          if (res.aiNotice) latestNotice = res.aiNotice;
        }

        if (domain !== 'All') {
          setRoadmapDomain(domain);
        }
        setSystemNotice(
          latestNotice ||
            (domain === 'All'
              ? opts?.onlyMissing
                ? `JARVIS designed ${targetDomains.length} missing Top 1% roadmap${
                    targetDomains.length === 1 ? '' : 's'
                  } in your unified sequence.`
                : 'JARVIS designed Top 1% roadmaps across all 5 engineering domains.'
              : `JARVIS designed and saved your ${domain} Top 1% mastery roadmap.`)
        );
      } catch (err) {
        setSystemNotice(
          err instanceof Error ? err.message : 'Unable to design domain roadmap.'
        );
      } finally {
        setDesigningRoadmapDomain(null);
        setDesigningRoadmapProgress(null);
      }
    },
    [profile, designingRoadmapDomain, projectMissions, skills, workLogs, domainRoadmaps]
  );

  const handleMarkJobTaskDoneFromJarvis = useCallback(
    async (act: Extract<JarvisAction, { type: 'mark_job_task_done' }>) => {
      if (!profile) return;
      try {
        const cleanTitle = act.projectName.trim() || 'Completed Job Task';
        const cleanSummary =
          act.taskSummary?.trim() ||
          `Completed job task "${cleanTitle}" and resumed learning path.`;

        const mapped = await mapWorkLogWithAi({
          projectName: cleanTitle,
          taskSummary: cleanSummary,
          minutesSpent: 60,
          currentSkills: skills,
        });

        const chosenDomain = act.domain || mapped.primaryDomain || 'AWS';
        const pendingProjectQuests = todayQuests.filter(
          (q) => q.status === 'pending' && q.mode === 'project_override'
        );

        const res = await markJobTaskDoneAndResumePath(
          profile.userId,
          profile,
          skills,
          domainRoadmaps,
          {
            jobTitle: cleanTitle,
            taskSummary: cleanSummary,
            domain: chosenDomain,
            extractedSkills: mapped.extractedSkills,
            matchedSkillTitles: mapped.matchedSkillTitles,
            elevationNote: mapped.elevationNote,
            xpAwarded: Math.max(120, mapped.xpAwarded),
            minutesSpent: 60,
            activeProject,
            pendingProjectQuests,
            markActiveProjectDone: Boolean(activeProject && act.resumePath !== false),
          }
        );

        if (res.exitedOverride || todayQuests.length === 0) {
          const todaySlot = profile.rotationMap[getTodayDayKey()];
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

        setRoadmapDomain(chosenDomain);
        setActivePage('roadmaps');
        setCelebration({
          kind: 'project',
          title: `Job Task Done · ${cleanTitle}`,
          subtitle: `${chosenDomain} roadmap (${res.stepsCompletedCount} step${
            res.stepsCompletedCount === 1 ? '' : 's'
          } ticked) and mastery credited. Normal learning path resumed.`,
          xpAwarded: Math.max(120, mapped.xpAwarded),
          domain: chosenDomain,
        });
      } catch (err) {
        setSystemNotice(
          err instanceof Error ? err.message : 'Unable to mark job task complete.'
        );
      }
    },
    [profile, skills, todayQuests, domainRoadmaps, activeProject, todayKey, workLogs, dueCardsCount]
  );

  const executeJarvisActions = useCallback(
    (actions: JarvisAction[], candidateQuests: DailyQuest[] = todayQuests): string[] => {
      const trace: string[] = [];

      const findSkill = (title: string, domain?: Domain) => {
        const targetLower = (title || '').toLowerCase();
        return (
          skills.find((s) => s.title.toLowerCase() === targetLower) ||
          skills.find(
            (s) =>
              targetLower.length > 0 &&
              (s.title.toLowerCase().includes(targetLower) ||
                targetLower.includes(s.title.toLowerCase()))
          ) ||
          (domain
            ? skills
                .filter((s) => s.domain === domain)
                .sort((a, b) => a.mastery - b.mastery)[0]
            : undefined)
        );
      };

      const findQuest = (questIdOrTitle: string, pendingOnly = false) => {
        const pool = pendingOnly
          ? candidateQuests.filter((q) => q.status === 'pending')
          : candidateQuests;
        const qLower = (questIdOrTitle || '').toLowerCase();
        return (
          pool.find((q) => q.id === questIdOrTitle) ||
          pool.find((q) => q.title.toLowerCase() === qLower) ||
          pool.find(
            (q) =>
              qLower.length > 0 &&
              (q.title.toLowerCase().includes(qLower) ||
                qLower.includes(q.title.toLowerCase()))
          ) ||
          pool[0] ||
          candidateQuests[0]
        );
      };

      for (const act of actions) {
        if (act.type === 'navigate') {
          if (act.page === 'profile') {
            setProfileDomainFilter(act.domainFilter || 'All');
            trace.push(
              `Switched screen → Profile${act.domainFilter && act.domainFilter !== 'All' ? ` (${act.domainFilter})` : ''}`
            );
          } else if (act.page === 'roadmaps') {
            setSelectedSkillId(null);
            if (act.domainFilter) {
              setRoadmapDomain(act.domainFilter);
            }
            trace.push(
              `Switched screen → Roadmaps (${
                act.domainFilter ? act.domainFilter : roadmapDomain
              })`
            );
          } else if (act.page === 'upload') {
            setSelectedSkillId(null);
            trace.push('Switched screen → Upload Task');
          } else {
            setSelectedSkillId(null);
            trace.push('Switched screen → Quests');
          }
          setActivePage(act.page);
        } else if (act.type === 'design_roadmap') {
          setSelectedSkillId(null);
          setRoadmapDomain(act.domain);
          setActivePage('roadmaps');
          void handleDesignRoadmap(act.domain, act.focusGoal);
          trace.push(
            `JARVIS Designing Roadmap → ${act.domain === 'All' ? 'All 5 Domains' : act.domain}`
          );
        } else if (act.type === 'mark_job_task_done') {
          setSelectedSkillId(null);
          void handleMarkJobTaskDoneFromJarvis(act);
          trace.push(`Marked Job Task Done & Resumed Path → ${act.projectName}`);
        } else if (act.type === 'open_skill') {
          const matchedSkill = findSkill(act.skillTitle, act.domain);
          if (matchedSkill) {
            setProfileDomainFilter(act.domain || matchedSkill.domain);
            setActivePage('profile');
            setSelectedSkillId(matchedSkill.id);
            trace.push(`Opened Study Brief → ${matchedSkill.title}`);
          } else {
            setProfileDomainFilter(act.domain || 'All');
            setActivePage('profile');
            trace.push(`Switched screen → Profile (${act.domain || 'All'})`);
          }
        } else if (act.type === 'refresh_study_brief') {
          const matchedSkill = findSkill(act.skillTitle, act.domain);
          if (matchedSkill) {
            setProfileDomainFilter(act.domain || matchedSkill.domain);
            setActivePage('profile');
            setSelectedSkillId(matchedSkill.id);
            void refreshSkillBriefFromJarvis(matchedSkill);
            trace.push(`Refreshed Study Brief → ${matchedSkill.title}`);
          }
        } else if (act.type === 'close_skill_drawer') {
          setSelectedSkillId(null);
          trace.push('Closed Study Brief drawer');
        } else if (act.type === 'focus_quest') {
          const matchedQuest = findQuest(act.questIdOrTitle, false);
          setSelectedSkillId(null);
          setActivePage('quests');
          if (matchedQuest) {
            setFocusedQuestId(matchedQuest.id);
            trace.push(`Focused Quest → ${matchedQuest.title}`);
          }
        } else if (act.type === 'complete_quest') {
          const matchedQuest = findQuest(act.questIdOrTitle, true);
          setSelectedSkillId(null);
          setActivePage('quests');
          if (matchedQuest && matchedQuest.status === 'pending') {
            void completeQuestFromJarvis(matchedQuest);
            trace.push(`Completed Quest → ${matchedQuest.title} (+${matchedQuest.xpReward} XP)`);
          }
        } else if (act.type === 'prefill_upload') {
          setSelectedSkillId(null);
          setPrefilledUpload({
            projectName: act.projectName,
            rawTaskBrief: act.rawTaskBrief,
            nonce: Date.now(),
          });
          setActivePage('upload');
          trace.push(
            `Opened Upload Task & prefilled "${act.projectName || 'Project Spec'}"`
          );
        } else if (act.type === 'refresh_quests') {
          setSelectedSkillId(null);
          setActivePage('quests');
          void refreshDailyQuestsFromJarvis();
          trace.push('Triggered Daily Quest refresh');
        } else if (act.type === 'structure_syllabus') {
          void structureSyllabusFromJarvis(act);
          const addedCount = act.addTopics?.length || 0;
          const updatedCount = act.updateTopics?.length || 0;
          const cardsCount = act.newReviewCards?.length || 0;
          const parts: string[] = [];
          if (addedCount > 0) parts.push(`+${addedCount} Top 1% topics`);
          if (updatedCount > 0) parts.push(`${updatedCount} elevated`);
          if (act.weeklyFocusOrder?.length) parts.push('rotation reordered');
          if (cardsCount > 0) parts.push(`+${cardsCount} recall cards`);
          trace.push(
            `Structured Syllabus${parts.length ? ` (${parts.join(' · ')})` : ''}`
          );
        } else if (act.type === 'award_skill_practice') {
          if (profile) {
            void awardSkillPracticeFromJarvis(
              profile.userId,
              skills,
              act.skillTitle,
              act.domain,
              act.masteryBoost ?? 6
            ).catch((err) =>
              setSystemNotice(
                err instanceof Error ? err.message : 'Unable to boost skill mastery.'
              )
            );
          }
          trace.push(
            `Mastery Boosted (+${act.masteryBoost ?? 6}%) → ${act.skillTitle}`
          );
        }
      }

      return Array.from(new Set(trace));
    },
    [
      profile,
      skills,
      todayQuests,
      roadmapDomain,
      refreshDailyQuestsFromJarvis,
      completeQuestFromJarvis,
      refreshSkillBriefFromJarvis,
      structureSyllabusFromJarvis,
      handleDesignRoadmap,
      handleMarkJobTaskDoneFromJarvis,
    ]
  );

  const persistJarvisMessages = useCallback(
    (uid: string, nextMessages: JarvisMessage[]) => {
      const capped = nextMessages.slice(-24);
      jarvisMessagesRef.current = capped;
      setJarvisMessages(capped);
      void saveJarvisThread(uid, capped, jarvisThreadExistsRef.current).catch((err) => {
        console.error('Unable to persist JARVIS thread:', err);
      });
    },
    []
  );

  const runJarvisTurn = useCallback(
    async (opts: {
      userMessage: string;
      trigger: JarvisTrigger;
      showUserBubble?: boolean;
      overrideActiveProject?: ProjectMission | null;
      overrideTodayQuests?: DailyQuest[];
    }) => {
      if (!profile || jarvisLoading) return;

      const trimmed = opts.userMessage.trim();
      const historySnapshot = jarvisMessagesRef.current
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.content }));

      if (opts.showUserBubble !== false && trimmed) {
        const userEntry: JarvisMessage = {
          id: `u-${Date.now()}`,
          role: 'user',
          content: trimmed,
          timestamp: new Date().toISOString(),
        };
        persistJarvisMessages(profile.userId, [...jarvisMessagesRef.current, userEntry]);
      }

      setJarvisOpen(true);
      setJarvisLoading(true);

      const effectiveProject =
        opts.overrideActiveProject !== undefined ? opts.overrideActiveProject : activeProject;
      const effectiveQuests =
        opts.overrideTodayQuests !== undefined ? opts.overrideTodayQuests : todayQuests;

      try {
        const res = await askJarvisWithAi({
          userMessage: trimmed,
          trigger: opts.trigger,
          currentScreen: {
            activePage,
            profileDomainFilter,
            selectedSkillTitle,
          },
          conversationHistory: historySnapshot,
          profile,
          activeProject: effectiveProject,
          skills,
          todayQuests: effectiveQuests,
        });

        const executedActions = executeJarvisActions(res.uiActions || [], effectiveQuests);
        const assistantEntry: JarvisMessage = {
          id: `a-${Date.now()}`,
          role: 'assistant',
          headline: res.headline,
          content: res.reply,
          codeSnippet: res.codeSnippet || undefined,
          interactiveMode: res.interactiveMode || 'mentor',
          executedActions,
          suggestedFollowUps: res.suggestedFollowUps,
          timestamp: new Date().toISOString(),
        };
        persistJarvisMessages(profile.userId, [...jarvisMessagesRef.current, assistantEntry]);
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : 'Unable to reach JARVIS mentor right now.';
        persistJarvisMessages(profile.userId, [
          ...jarvisMessagesRef.current,
          {
            id: `e-${Date.now()}`,
            role: 'assistant',
            headline: 'Command Warning',
            content: errMsg,
            timestamp: new Date().toISOString(),
          },
        ]);
      } finally {
        setJarvisLoading(false);
      }
    },
    [
      profile,
      jarvisLoading,
      activeProject,
      todayQuests,
      activePage,
      profileDomainFilter,
      selectedSkillTitle,
      skills,
      executeJarvisActions,
      persistJarvisMessages,
    ]
  );

  const handleProjectActivated = useCallback(
    (aiPlan: SystemUploadProjectResult) => {
      if (!profile) return;

      // Construct immediate snapshot so JARVIS analyzes the uploaded plan even before Firestore listener ticks
      const syntheticProject: ProjectMission = {
        id: 'pending-sync',
        userId: profile.userId,
        projectName: aiPlan.projectName,
        rawTaskBrief: aiPlan.masteryGoal,
        primaryDomain: aiPlan.primaryDomain,
        domains: aiPlan.domains,
        status: 'active',
        rank: aiPlan.rank,
        masteryGoal: aiPlan.masteryGoal,
        linkedSkillTitles: [],
        masterSyllabusModules: aiPlan.masterSyllabusModules,
        completedAt: '',
      };

      const syntheticQuests: DailyQuest[] =
        todayQuests.some((q) => q.projectName === aiPlan.projectName)
          ? todayQuests
          : aiPlan.dailyQuests.map((q, idx) => ({
              id: `draft-${idx}`,
              userId: profile.userId,
              dateKey: todayKey,
              mode: 'project_override',
              projectMissionId: 'pending-sync',
              projectName: aiPlan.projectName,
              domain: q.domain,
              questType: q.questType,
              rank: q.rank,
              title: q.title,
              objective: q.objective,
              masteryChecklist: q.masteryChecklist,
              linkedSkillTitle: q.linkedSkillTitle,
              estimatedMinutes: q.estimatedMinutes,
              xpReward: q.xpReward,
              status: 'pending',
              completedAt: '',
            }));

      void runJarvisTurn({
        userMessage: `Analyze newly uploaded project "${aiPlan.projectName}" and tell me step-by-step what to execute first.`,
        trigger: 'post_upload_brief',
        showUserBubble: false,
        overrideActiveProject: syntheticProject,
        overrideTodayQuests: syntheticQuests,
      });
    },
    [profile, todayQuests, todayKey, runJarvisTurn]
  );

  const handleAskJarvisFromScreen = useCallback(
    (prompt: string) => {
      void runJarvisTurn({
        userMessage: prompt,
        trigger: 'user_chat',
        showUserBubble: true,
      });
    },
    [runJarvisTurn]
  );

  const handleAppendJarvisMessage = useCallback(
    (msg: JarvisMessage) => {
      if (!profile) {
        const next = [...jarvisMessagesRef.current, msg].slice(-24);
        jarvisMessagesRef.current = next;
        setJarvisMessages(next);
        return;
      }
      persistJarvisMessages(profile.userId, [...jarvisMessagesRef.current, msg]);
    },
    [profile, persistJarvisMessages]
  );

  const handleClearJarvisHistory = useCallback(() => {
    if (!profile) {
      jarvisMessagesRef.current = [];
      setJarvisMessages([]);
      return;
    }
    persistJarvisMessages(profile.userId, []);
  }, [profile, persistJarvisMessages]);

  // Proactive JARVIS startup briefing once workspace, skills, missions, quests, and thread sync on desktop
  useEffect(() => {
    if (
      !workspaceReady ||
      !profile?.calibrated ||
      !missionsSynced ||
      !questsSynced ||
      !jarvisThreadSynced ||
      skills.length === 0 ||
      todayQuests.length === 0 ||
      jarvisMessages.length > 0 ||
      jarvisLoading
    ) {
      return;
    }

    if (proactiveScanUserRef.current === profile.userId) return;
    proactiveScanUserRef.current = profile.userId;

    if (typeof window !== 'undefined' && window.innerWidth >= 1024) {
      void runJarvisTurn({
        userMessage: 'Analyze my active project and today’s quests and tell me what to do next.',
        trigger: 'proactive_scan',
        showUserBubble: false,
      });
    }
  }, [
    workspaceReady,
    profile,
    missionsSynced,
    questsSynced,
    jarvisThreadSynced,
    skills,
    todayQuests,
    jarvisMessages.length,
    jarvisLoading,
    runJarvisTurn,
  ]);

  if (!authReady) {
    return (
      <div className="min-h-screen bg-[#0B0F17] flex items-center justify-center">
        <div className="text-xs font-mono text-slate-400">Initializing session...</div>
      </div>
    );
  }

  if (!user) {
    return <AuthGate />;
  }

  if (bootError) {
    return (
      <div className="min-h-screen bg-[#0B0F17] text-[#F1F5F9] flex items-center justify-center p-6">
        <div className="max-w-lg w-full bg-[#121824] border border-red-800/60 rounded-xl p-6 space-y-4">
          <h1 className="font-display text-lg font-semibold text-red-200">
            Workspace Sync Error
          </h1>
          <p className="text-xs font-mono text-red-300/90 break-words">{bootError}</p>
          <button
            type="button"
            onClick={() => signOut(auth)}
            className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-100 cursor-pointer"
          >
            Sign out and retry
          </button>
        </div>
      </div>
    );
  }

  if (!workspaceReady || !profile) {
    return (
      <div className="min-h-screen bg-[#0B0F17] p-6 md:p-10">
        <div className="max-w-5xl mx-auto space-y-6 animate-pulse">
          <div className="h-10 w-56 bg-[#121824] rounded-lg border border-slate-800/80" />
          <div className="h-28 bg-[#121824] rounded-xl border border-slate-800/80" />
          <div className="h-72 bg-[#121824] rounded-xl border border-slate-800/80" />
        </div>
      </div>
    );
  }

  if (!profile.calibrated) {
    return <CalibrationView profile={profile} skills={skills} />;
  }

  return (
    <div
      className={`min-h-screen bg-[#0B0F17] text-[#F1F5F9] flex flex-col transition-[padding] duration-200 ${
        jarvisOpen ? 'lg:pr-[440px]' : ''
      }`}
    >
      {/* Clean 3-Zone Top Bar (Desktop) & Compact Mobile Header */}
      <header className="md:sticky md:top-0 z-30 bg-[#0B0F17]/95 backdrop-blur-sm border-b border-slate-800/80">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 h-12 md:h-14 flex items-center justify-between gap-4 sm:gap-8">
          {/* Zone 1: Wordmark */}
          <span className="font-display text-base sm:text-lg font-bold tracking-tight text-slate-50 whitespace-nowrap shrink-0">
            ApexStack
          </span>

          {/* Zone 2: Desktop Primary Pages */}
          <nav className="hidden md:flex items-center gap-6" aria-label="Primary navigation">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activePage === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleNavigate(item.id)}
                  className={`inline-flex items-center gap-1.5 py-1 text-sm transition-colors cursor-pointer whitespace-nowrap shrink-0 border-b-2 ${
                    isActive
                      ? 'border-sky-400 text-slate-50 font-semibold'
                      : 'border-transparent text-slate-400 hover:text-slate-100'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5 shrink-0" />
                  <span>{item.label}</span>
                  {item.id === 'quests' && pendingTodayQuestsCount > 0 && (
                    <span className="font-mono text-[11px] text-sky-400 tabular-nums">
                      ({pendingTodayQuestsCount})
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Zone 3: 1 Primary Action */}
          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() =>
                handleNavigate(activePage === 'upload' ? 'quests' : 'upload')
              }
              className="px-3.5 py-1.5 min-h-[36px] md:min-h-0 rounded-lg bg-sky-500 hover:bg-sky-400 text-slate-950 text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              {activePage === 'upload' ? 'View Quests' : 'Upload Project'}
            </button>
          </div>
        </div>
      </header>

      {/* Mobile Fixed Bottom Thumb-Zone Navigation */}
      <nav
        aria-label="Mobile navigation"
        className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0B0F17]/95 backdrop-blur-md border-t border-slate-800/90 pb-safe"
      >
        <div className="grid grid-cols-4 h-14">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activePage === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => handleNavigate(item.id)}
                className={`relative flex flex-col items-center justify-center gap-0.5 min-h-[44px] transition-colors cursor-pointer ${
                  isActive ? 'text-sky-400' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <div className="relative">
                  <Icon className="w-5 h-5" />
                  {item.id === 'quests' && pendingTodayQuestsCount > 0 && (
                    <span className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-sky-500 text-slate-950 font-mono text-[10px] font-bold flex items-center justify-center tabular-nums">
                      {pendingTodayQuestsCount}
                    </span>
                  )}
                </div>
                <span className="text-[11px] font-medium tracking-tight whitespace-nowrap">
                  {item.id === 'upload' ? 'Upload' : item.label}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      <main className="flex-1 w-full max-w-6xl mx-auto px-3.5 sm:px-6 py-4 sm:py-6 md:py-8 pb-28 md:pb-20">
        {activePage === 'quests' && (
          <QuestsPage
            profile={profile}
            skills={skills}
            workLogs={workLogs}
            missions={projectMissions}
            quests={dailyQuests}
            roadmaps={domainRoadmaps}
            dueCardsCount={dueCardsCount}
            autoGenerating={autoGeneratingQuests}
            focusedQuestId={focusedQuestId}
            systemNotice={systemNotice}
            onDismissNotice={() => setSystemNotice(null)}
            onNavigate={handleNavigate}
            onOpenRecall={() => setRecallOpen(true)}
            onCelebrate={setCelebration}
            onAskJarvis={handleAskJarvisFromScreen}
          />
        )}

        {activePage === 'roadmaps' && (
          <RoadmapsPage
            profile={profile}
            skills={skills}
            workLogs={workLogs}
            missions={projectMissions}
            quests={dailyQuests}
            roadmaps={domainRoadmaps}
            dueCardsCount={dueCardsCount}
            selectedDomain={roadmapDomain}
            onSelectDomain={setRoadmapDomain}
            designingDomain={designingRoadmapDomain}
            designingProgress={designingRoadmapProgress}
            onDesignRoadmap={(d, focusGoal) => handleDesignRoadmap(d, focusGoal)}
            onDesignAllRoadmaps={(opts) =>
              handleDesignRoadmap('All', opts?.focusGoal, {
                onlyMissing: opts?.onlyMissing,
              })
            }
            onCelebrate={setCelebration}
            onNotify={setSystemNotice}
            onNavigate={handleNavigate}
            onAskJarvis={handleAskJarvisFromScreen}
          />
        )}

        {activePage === 'upload' && (
          <UploadTaskPage
            profile={profile}
            skills={skills}
            workLogs={workLogs}
            missions={projectMissions}
            quests={dailyQuests}
            roadmaps={domainRoadmaps}
            dueCardsCount={dueCardsCount}
            prefilledUpload={prefilledUpload}
            onNotify={setSystemNotice}
            onNavigate={handleNavigate}
            onCelebrate={setCelebration}
            onProjectActivated={handleProjectActivated}
            onAskJarvis={handleAskJarvisFromScreen}
          />
        )}

        {activePage === 'profile' && (
          <ProfilePage
            user={user}
            profile={profile}
            skills={skills}
            missions={projectMissions}
            quests={dailyQuests}
            domainFilter={profileDomainFilter}
            onDomainFilterChange={setProfileDomainFilter}
            selectedSkillId={selectedSkillId}
            onSelectSkillId={setSelectedSkillId}
            dueCardsCount={dueCardsCount}
            onOpenRecall={() => setRecallOpen(true)}
            onAskJarvis={handleAskJarvisFromScreen}
            jarvisOpen={jarvisOpen}
          />
        )}
      </main>

      <ActiveRecallDrawer
        open={recallOpen}
        userId={profile.userId}
        cards={reviewCards}
        defaultDomain={
          activePage === 'roadmaps' && roadmapDomain !== 'All' ? roadmapDomain : 'AWS'
        }
        jarvisOpen={jarvisOpen}
        onClose={() => setRecallOpen(false)}
        onNotify={setSystemNotice}
      />

      <JarvisConsole
        open={jarvisOpen}
        loading={jarvisLoading}
        messages={jarvisMessages}
        activePage={activePage}
        profileDomainFilter={
          activePage === 'roadmaps' ? roadmapDomain : profileDomainFilter
        }
        selectedSkillTitle={selectedSkillTitle}
        profile={profile}
        skills={skills}
        todayQuests={todayQuests}
        activeProject={activeProject}
        pendingQuestsCount={pendingTodayQuestsCount}
        onToggleOpen={setJarvisOpen}
        onSendMessage={(msg) =>
          void runJarvisTurn({
            userMessage: msg,
            trigger: 'user_chat',
            showUserBubble: true,
          })
        }
        onExecuteActions={(actions) => executeJarvisActions(actions)}
        onAddMessage={handleAppendJarvisMessage}
        onClearHistory={handleClearJarvisHistory}
        onAnalyzeNow={() =>
          void runJarvisTurn({
            userMessage: 'Analyze my active project and today’s quests and tell me what to do next.',
            trigger: 'proactive_scan',
            showUserBubble: true,
          })
        }
      />

      <CelebrationOverlay
        event={celebration}
        onDismiss={() => setCelebration(null)}
      />
    </div>
  );
}

