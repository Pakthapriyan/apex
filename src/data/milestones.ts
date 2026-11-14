import { DOMAINS } from './seedCurriculum';
import type {
  DailyQuest,
  Domain,
  ProjectMission,
  SkillNode,
  UserProfile,
} from '../types/learning';

export interface MilestoneItem {
  id: string;
  title: string;
  category: 'Quests' | 'Projects' | 'Mastery' | 'Consistency';
  description: string;
  current: number;
  target: number;
  unlocked: boolean;
  rewardLabel: string;
}

export function computeMilestones(params: {
  profile: UserProfile;
  skills: SkillNode[];
  missions: ProjectMission[];
  quests: DailyQuest[];
  todayKey: string;
}): MilestoneItem[] {
  const { profile, skills, missions, quests, todayKey } = params;

  const completedQuestsCount = quests.filter((q) => q.status === 'completed').length;
  const todayQuests = quests.filter((q) => q.dateKey === todayKey);
  const todayCleared = todayQuests.filter((q) => q.status === 'completed').length;
  const todayTarget = Math.max(1, todayQuests.length);
  const completedMissionsCount = missions.filter((m) => m.status === 'completed').length;

  const domainAvgs = DOMAINS.map((domain) => {
    const subset = skills.filter((s) => s.domain === domain);
    return subset.length > 0
      ? Math.round(subset.reduce((sum, s) => sum + s.mastery, 0) / subset.length)
      : 0;
  });
  const bestDomainAvg = Math.max(0, ...domainAvgs);
  const overallMastery =
    skills.length > 0
      ? Math.round(skills.reduce((sum, s) => sum + s.mastery, 0) / skills.length)
      : 0;
  const top1Mastered = skills.filter((s) => s.tier === 'Top 1%' && s.mastery >= 80).length;

  return [
    {
      id: 'first-quest',
      title: 'First Quest Cleared',
      category: 'Quests',
      description: 'Complete your first daily System Quest.',
      current: Math.min(1, completedQuestsCount),
      target: 1,
      unlocked: completedQuestsCount >= 1,
      rewardLabel: '+1 Quest Streak Start',
    },
    {
      id: 'daily-sweep',
      title: 'Daily Full Clear',
      category: 'Quests',
      description: 'Complete every quest assigned for today.',
      current: todayQuests.length > 0 ? todayCleared : 0,
      target: todayTarget,
      unlocked: todayQuests.length > 0 && todayCleared >= todayQuests.length,
      rewardLabel: '100% Daily Clearance',
    },
    {
      id: 'quest-veteran',
      title: '10 Quests Completed',
      category: 'Quests',
      description: 'Clear 10 daily engineering and mastery quests.',
      current: Math.min(10, completedQuestsCount),
      target: 10,
      unlocked: completedQuestsCount >= 10,
      rewardLabel: 'B-Rank Momentum',
    },
    {
      id: 'project-vanguard',
      title: 'Project Override Activated',
      category: 'Projects',
      description: 'Upload a project task so the System restructures your syllabus.',
      current: Math.min(1, missions.length),
      target: 1,
      unlocked: missions.length >= 1,
      rewardLabel: 'Priority Syllabus Sync',
    },
    {
      id: 'mission-cleared',
      title: 'Project Mission Completed',
      category: 'Projects',
      description: 'Finish an active project mission and return to Normal Routine.',
      current: Math.min(1, completedMissionsCount),
      target: 1,
      unlocked: completedMissionsCount >= 1,
      rewardLabel: '+250 Mission Bonus XP',
    },
    {
      id: 'streak-3',
      title: '3-Day Consistency Streak',
      category: 'Consistency',
      description: 'Stay active across 3 consecutive days.',
      current: Math.min(3, profile.streakDays),
      target: 3,
      unlocked: profile.streakDays >= 3,
      rewardLabel: 'Habit Lock-In',
    },
    {
      id: 'domain-60',
      title: 'Domain Specialist (60%)',
      category: 'Mastery',
      description: 'Reach 60% average mastery in any of the 5 core domains.',
      current: Math.min(60, bestDomainAvg),
      target: 60,
      unlocked: bestDomainAvg >= 60,
      rewardLabel: 'Senior Domain Readiness',
    },
    {
      id: 'top1-nodes-3',
      title: 'Top 1% Contender',
      category: 'Mastery',
      description: 'Reach 80%+ mastery on 3 Top 1% tier syllabus nodes.',
      current: Math.min(3, top1Mastered),
      target: 3,
      unlocked: top1Mastered >= 3,
      rewardLabel: 'Staff-Level Depth',
    },
    {
      id: 's-rank-80',
      title: 'S-Rank Architect (80%)',
      category: 'Mastery',
      description: 'Reach 80% overall mastery across all 5 engineering domains.',
      current: Math.min(80, overallMastery),
      target: 80,
      unlocked: overallMastery >= 80,
      rewardLabel: 'Top 1% Multi-Cloud Mastery',
    },
  ];
}

export function computeHunterStats(params: {
  skills: SkillNode[];
  quests: DailyQuest[];
  missions: ProjectMission[];
}) {
  const { skills, quests, missions } = params;
  const overallMastery =
    skills.length > 0
      ? Math.round(skills.reduce((sum, s) => sum + s.mastery, 0) / skills.length)
      : 0;
  const questXp = quests
    .filter((q) => q.status === 'completed')
    .reduce((sum, q) => sum + q.xpReward, 0);
  const missionXp = missions.filter((m) => m.status === 'completed').length * 250;
  const totalXp = questXp + missionXp;

  const level = Math.max(1, Math.floor(totalXp / 250) + 1);
  const xpInLevel = totalXp % 250;
  const xpSpan = 250;

  const score = level * 3 + overallMastery;
  let rank = 'E-Rank Initiate';
  if (score >= 160) rank = 'National Authority';
  else if (score >= 130) rank = 'S-Rank Monarch';
  else if (score >= 105) rank = 'A-Rank Architect';
  else if (score >= 80) rank = 'B-Rank Specialist';
  else if (score >= 55) rank = 'C-Rank Engineer';
  else if (score >= 30) rank = 'D-Rank Associate';

  return {
    totalXp,
    overallMastery,
    level,
    rank,
    xpInLevel,
    xpSpan,
  };
}

export interface DomainLevelStats {
  domain: Domain;
  level: number;
  maxLevel: number;
  rankTitle: string;
  avgMastery: number;
  top1NodesReady: number;
  top1NodesTotal: number;
  roadmapStepsDone: number;
  roadmapStepsTotal: number;
  roadmapPct: number;
  domainXp: number;
  readinessScore: number;
  progressToNextLevelPct: number;
  completedJobsCount: number;
}

const DOMAIN_LEVEL_BANDS: Array<{ minScore: number; level: number; title: string }> = [
  { minScore: 93, level: 10, title: 'Top 1% · Apex Authority' },
  { minScore: 86, level: 9, title: 'S+ · Distinguished Lead' },
  { minScore: 78, level: 8, title: 'S-Rank · Principal Architect' },
  { minScore: 70, level: 7, title: 'A+ · Staff Specialist' },
  { minScore: 61, level: 6, title: 'A-Rank · Senior Craftsman' },
  { minScore: 52, level: 5, title: 'B+ · Production Engineer' },
  { minScore: 42, level: 4, title: 'B-Rank · Cloud Builder' },
  { minScore: 31, level: 3, title: 'C-Rank · Practitioner' },
  { minScore: 18, level: 2, title: 'D-Rank · Associate' },
  { minScore: 0, level: 1, title: 'E-Rank · Initiate' },
];

export function computeDomainLevelStats(params: {
  domain: Domain;
  skills: SkillNode[];
  quests: DailyQuest[];
  missions: ProjectMission[];
  workLogs: Array<{ primaryDomain: Domain; xpAwarded: number }>;
  roadmap?: {
    stages: Array<{ steps: Array<{ completed: boolean }> }>;
    completedJobTasks?: string[];
  } | null;
}): DomainLevelStats {
  const domSkills = params.skills.filter((s) => s.domain === params.domain);
  const avgMastery =
    domSkills.length > 0
      ? Math.round(domSkills.reduce((sum, s) => sum + s.mastery, 0) / domSkills.length)
      : 0;
  const top1Nodes = domSkills.filter((s) => s.tier === 'Top 1%');
  const top1NodesReady = top1Nodes.filter((s) => s.mastery >= 80).length;

  const allSteps = (params.roadmap?.stages || []).flatMap((st) => st.steps || []);
  const roadmapStepsTotal = allSteps.length;
  const roadmapStepsDone = allSteps.filter((st) => st.completed).length;
  const roadmapPct =
    roadmapStepsTotal > 0 ? Math.round((roadmapStepsDone / roadmapStepsTotal) * 100) : 0;

  const questXp = params.quests
    .filter((q) => q.status === 'completed' && q.domain === params.domain)
    .reduce((sum, q) => sum + q.xpReward, 0);
  const logXp = params.workLogs
    .filter((l) => l.primaryDomain === params.domain)
    .reduce((sum, l) => sum + (l.xpAwarded || 0), 0);
  const completedMissions = params.missions.filter(
    (m) => m.status === 'completed' && m.primaryDomain === params.domain
  ).length;
  const completedJobsCount = Math.max(
    completedMissions,
    params.roadmap?.completedJobTasks?.length || 0
  );

  const domainXp = questXp + logXp + roadmapStepsDone * 60 + completedMissions * 250;
  const xpBonus = Math.min(10, Math.floor(domainXp / 200));

  const baseScore =
    roadmapStepsTotal > 0 ? avgMastery * 0.65 + roadmapPct * 0.35 : avgMastery;
  const readinessScore = Math.min(100, Math.round(baseScore + xpBonus * 0.5));

  const band =
    DOMAIN_LEVEL_BANDS.find((b) => readinessScore >= b.minScore) ||
    DOMAIN_LEVEL_BANDS[DOMAIN_LEVEL_BANDS.length - 1];

  const bandIndex = DOMAIN_LEVEL_BANDS.indexOf(band);
  const nextBand = bandIndex > 0 ? DOMAIN_LEVEL_BANDS[bandIndex - 1] : null;
  const progressToNextLevelPct = nextBand
    ? Math.min(
        100,
        Math.max(
          0,
          Math.round(
            ((readinessScore - band.minScore) /
              Math.max(1, nextBand.minScore - band.minScore)) *
              100
          )
        )
      )
    : 100;

  return {
    domain: params.domain,
    level: band.level,
    maxLevel: 10,
    rankTitle: band.title,
    avgMastery,
    top1NodesReady,
    top1NodesTotal: top1Nodes.length,
    roadmapStepsDone,
    roadmapStepsTotal,
    roadmapPct,
    domainXp,
    readinessScore,
    progressToNextLevelPct,
    completedJobsCount,
  };
}

