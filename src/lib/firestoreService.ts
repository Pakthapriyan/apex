import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
  type Unsubscribe,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from './firebase';
import {
  DEFAULT_ROTATION_MAP,
  DOMAINS,
  SEED_REVIEW_CARDS,
  SEED_SKILLS,
} from '../data/seedCurriculum';
import type {
  AdaptedSyllabusResult,
  AgentMessage,
  AgentSession,
  DailyQuest,
  DayKey,
  Domain,
  DomainRoadmap,
  DrillEvaluation,
  DrillMessage,
  GeneratedQuestDraft,
  IncidentDrill,
  JarvisMessage,
  ProjectMission,
  QuestType,
  ReviewCard,
  RotationSlot,
  SkillNode,
  SkillPriority,
  SkillTier,
  SyllabusProposal,
  SystemMode,
  SystemRank,
  SystemUploadProjectResult,
  UserProfile,
  WorkLog,
} from '../types/learning';

const VALID_TIERS: SkillTier[] = ['Foundational', 'Senior', 'Top 1%'];
const VALID_PRIORITIES: SkillPriority[] = ['Critical', 'High', 'Normal'];
const VALID_MISSION_RANKS: Array<'C-Rank' | 'B-Rank' | 'A-Rank' | 'S-Rank'> = [
  'C-Rank',
  'B-Rank',
  'A-Rank',
  'S-Rank',
];
const VALID_QUEST_RANKS: SystemRank[] = [
  'E-Rank',
  'D-Rank',
  'C-Rank',
  'B-Rank',
  'A-Rank',
  'S-Rank',
];
const VALID_QUEST_TYPES: QuestType[] = [
  'Project Execution',
  'Domain Mastery',
  'Production Drill',
  'Active Recall',
];

function clip(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function nonEmptyClip(value: unknown, fallback: string, max: number): string {
  const clipped = clip(value, max);
  return clipped.length > 0 ? clipped : fallback.trim().slice(0, max);
}

function safeDomain(value: unknown, fallback: Domain = 'AWS'): Domain {
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    const direct = DOMAINS.find((d) => d.toLowerCase() === cleaned);
    if (direct) return direct;
    if (cleaned.includes('angular')) return 'Angular';
    if (cleaned.includes('fastapi') || cleaned.includes('python')) return 'FastAPI';
    if (cleaned.includes('aws') || cleaned.includes('sqs') || cleaned.includes('eks')) return 'AWS';
    if (cleaned.includes('gcp') || cleaned.includes('google')) return 'GCP';
    if (cleaned.includes('devops') || cleaned.includes('k8s') || cleaned.includes('kubernetes')) {
      return 'DevOps';
    }
  }
  return DOMAINS.includes(fallback) ? fallback : 'AWS';
}

function safeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    const match = allowed.find((item) => item.toLowerCase() === cleaned);
    if (match) return match;
  }
  return fallback;
}

export function getTodayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getTodayDayKey(): DayKey {
  const map: DayKey[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return map[new Date().getDay()];
}

export async function ensureUserWorkspace(
  uid: string,
  displayName: string
): Promise<UserProfile> {
  const userRef = doc(db, 'users', uid);
  try {
    const snap = await getDoc(userRef);
    if (snap.exists()) {
      return snap.data() as UserProfile;
    }

    const today = getTodayIsoDate();
    const initialProfile: UserProfile = {
      userId: uid,
      displayName: clip(displayName || 'Cloud Engineer', 120),
      roleTitle: 'Associate Cloud Engineer',
      weeklyHoursTarget: 10,
      calibrated: false,
      streakDays: 1,
      lastActiveDate: today,
      rotationMap: { ...DEFAULT_ROTATION_MAP },
      completedRotationDays: [],
      domainFocusMinutes: {
        Angular: 0,
        FastAPI: 0,
        DevOps: 0,
        AWS: 0,
        GCP: 0,
      },
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    await setDoc(userRef, initialProfile);

    // Seed initial 5-domain Top 1% curriculum & SM-2 cards after parent doc exists
    const batch = writeBatch(db);
    const nowIso = new Date().toISOString();

    for (const template of SEED_SKILLS) {
      const skillRef = doc(collection(db, 'users', uid, 'skills'));
      batch.set(skillRef, {
        userId: uid,
        domain: template.domain,
        title: clip(template.title, 160),
        tier: template.tier,
        priority: 'Normal',
        projectTag: '',
        mastery: template.tier === 'Foundational' ? 55 : template.tier === 'Senior' ? 32 : 18,
        targetMastery: 95,
        description: clip(template.description, 600),
        studyBrief: clip(template.studyBrief, 8000),
        labPrompt: clip(template.labPrompt, 2000),
        practiceCount: 0,
        lastPracticedAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    for (const card of SEED_REVIEW_CARDS) {
      const cardRef = doc(collection(db, 'users', uid, 'reviewCards'));
      batch.set(cardRef, {
        userId: uid,
        domain: card.domain,
        skillTitle: clip(card.skillTitle, 160),
        prompt: clip(card.prompt, 2000),
        answer: clip(card.answer, 3000),
        explanation: clip(card.explanation, 3000),
        easeFactor: 2.5,
        intervalDays: 0,
        repetitions: 0,
        nextReviewAt: nowIso,
        lastReviewedAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();
    return initialProfile;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}`);
  }
}

export function subscribeUserProfile(
  uid: string,
  onData: (profile: UserProfile | null) => void
): Unsubscribe {
  const ref = doc(db, 'users', uid);
  return onSnapshot(
    ref,
    (snap) => {
      onData(snap.exists() ? (snap.data() as UserProfile) : null);
    },
    (error) => handleFirestoreError(error, OperationType.GET, `users/${uid}`)
  );
}

export function subscribeSkills(
  uid: string,
  onData: (skills: SkillNode[]) => void
): Unsubscribe {
  const path = `users/${uid}/skills`;
  const q = query(collection(db, path), where('userId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as SkillNode));
      onData(rows);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export function subscribeWorkLogs(
  uid: string,
  onData: (logs: WorkLog[]) => void
): Unsubscribe {
  const path = `users/${uid}/workLogs`;
  const q = query(
    collection(db, path),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as WorkLog));
      onData(rows);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export function subscribeDrills(
  uid: string,
  onData: (drills: IncidentDrill[]) => void
): Unsubscribe {
  const path = `users/${uid}/drills`;
  const q = query(
    collection(db, path),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as IncidentDrill));
      onData(rows);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export function subscribeReviewCards(
  uid: string,
  onData: (cards: ReviewCard[]) => void
): Unsubscribe {
  const path = `users/${uid}/reviewCards`;
  const q = query(collection(db, path), where('userId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ReviewCard));
      onData(rows);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function saveCalibration(
  uid: string,
  weeklyHoursTarget: number,
  roleTitle: string,
  domainRatings: Record<Domain, number>,
  skills: SkillNode[]
): Promise<void> {
  const userRef = doc(db, 'users', uid);
  try {
    const batch = writeBatch(db);
    batch.update(userRef, {
      calibrated: true,
      weeklyHoursTarget: Math.min(60, Math.max(1, Math.round(weeklyHoursTarget))),
      roleTitle: clip(roleTitle || 'Associate Cloud Engineer', 120),
      rotationMap: { ...DEFAULT_ROTATION_MAP },
      updatedAt: serverTimestamp(),
    });

    for (const skill of skills) {
      const base = domainRatings[skill.domain] ?? 40;
      const tierOffset = skill.tier === 'Foundational' ? 12 : skill.tier === 'Senior' ? 0 : -14;
      const calibratedMastery = Math.min(92, Math.max(8, Math.round(base + tierOffset)));
      const skillRef = doc(db, 'users', uid, 'skills', skill.id);
      batch.update(skillRef, {
        mastery: calibratedMastery,
        practiceCount: skill.practiceCount,
        lastPracticedAt: skill.lastPracticedAt,
        updatedAt: serverTimestamp(),
      });
    }

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function toggleRotationDayComplete(
  uid: string,
  profile: UserProfile,
  day: DayKey,
  minutesPerBlock: number
): Promise<void> {
  const userRef = doc(db, 'users', uid);
  const slot = profile.rotationMap[day];
  const alreadyCompleted = profile.completedRotationDays.includes(day);
  const nextCompleted = alreadyCompleted
    ? profile.completedRotationDays.filter((d) => d !== day)
    : [...profile.completedRotationDays, day];

  const nextFocusMinutes = { ...profile.domainFocusMinutes };
  if (DOMAINS.includes(slot as Domain)) {
    const dom = slot as Domain;
    const delta = alreadyCompleted ? -minutesPerBlock : minutesPerBlock;
    nextFocusMinutes[dom] = Math.max(0, (nextFocusMinutes[dom] || 0) + delta);
  }

  const today = getTodayIsoDate();
  const nextStreak =
    !alreadyCompleted && profile.lastActiveDate !== today
      ? profile.streakDays + 1
      : profile.streakDays;

  try {
    await updateDoc(userRef, {
      completedRotationDays: nextCompleted,
      domainFocusMinutes: nextFocusMinutes,
      streakDays: nextStreak,
      lastActiveDate: today,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function rebalanceWeeklyRotation(
  uid: string,
  skills: SkillNode[],
  profile: UserProfile
): Promise<void> {
  // Rank domains from lowest average mastery & focus minutes so lagging domains get priority Mon-Fri
  const scores = DOMAINS.map((domain) => {
    const domSkills = skills.filter((s) => s.domain === domain);
    const avgMastery =
      domSkills.length > 0
        ? domSkills.reduce((acc, s) => acc + s.mastery, 0) / domSkills.length
        : 50;
    const minutes = profile.domainFocusMinutes[domain] || 0;
    return {
      domain,
      priority: avgMastery + minutes * 0.15,
    };
  }).sort((a, b) => a.priority - b.priority);

  const rebalancedMap: Record<DayKey, RotationSlot> = {
    Mon: scores[0].domain,
    Tue: scores[1].domain,
    Wed: scores[2].domain,
    Thu: scores[3].domain,
    Fri: scores[4].domain,
    Sat: 'Multi-Cloud Synthesis',
    Sun: 'Review & Gap Audit',
  };

  try {
    await updateDoc(doc(db, 'users', uid), {
      rotationMap: rebalancedMap,
      completedRotationDays: [],
      domainFocusMinutes: {
        Angular: 0,
        FastAPI: 0,
        DevOps: 0,
        AWS: 0,
        GCP: 0,
      },
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function createSkillNode(
  uid: string,
  payload: {
    domain: Domain;
    title: string;
    tier: SkillTier;
    priority?: SkillPriority;
    projectTag?: string;
    description: string;
    studyBrief?: string;
    labPrompt: string;
  }
): Promise<void> {
  const path = `users/${uid}/skills`;
  try {
    const ref = doc(collection(db, path));
    await setDoc(ref, {
      userId: uid,
      domain: payload.domain,
      title: clip(payload.title, 160),
      tier: payload.tier,
      priority: payload.priority || 'Normal',
      projectTag: clip(payload.projectTag || '', 80),
      mastery: 15,
      targetMastery: 95,
      description: clip(payload.description, 600),
      studyBrief: clip(payload.studyBrief || payload.description, 8000),
      labPrompt: clip(payload.labPrompt, 2000),
      practiceCount: 0,
      lastPracticedAt: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateSkillPriority(
  uid: string,
  skillId: string,
  priority: SkillPriority,
  projectTag: string
): Promise<void> {
  const path = `users/${uid}/skills/${skillId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'skills', skillId), {
      priority,
      projectTag: clip(projectTag, 80),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function adaptRotationToPriorities(
  uid: string,
  skills: SkillNode[]
): Promise<void> {
  const ranked = DOMAINS.map((domain) => {
    const domSkills = skills.filter((s) => s.domain === domain);
    const criticalCount = domSkills.filter((s) => s.priority === 'Critical').length;
    const highCount = domSkills.filter((s) => s.priority === 'High').length;
    const avgMastery =
      domSkills.length > 0
        ? domSkills.reduce((acc, s) => acc + s.mastery, 0) / domSkills.length
        : 50;
    return {
      domain,
      weight: criticalCount * 100 + highCount * 35 + (100 - avgMastery) * 0.4,
    };
  }).sort((a, b) => b.weight - a.weight);

  const nextMap: Record<DayKey, RotationSlot> = {
    Mon: ranked[0].domain,
    Tue: ranked[1].domain,
    Wed: ranked[2].domain,
    Thu: ranked[3].domain,
    Fri: ranked[4].domain,
    Sat: 'Multi-Cloud Synthesis',
    Sun: 'Review & Gap Audit',
  };

  try {
    await updateDoc(doc(db, 'users', uid), {
      rotationMap: nextMap,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, `users/${uid}`);
  }
}

export async function applyAdaptedSyllabus(
  uid: string,
  skills: SkillNode[],
  projectTag: string,
  adapted: AdaptedSyllabusResult,
  options: { adaptWeeklyRotation: boolean; addSuggestedCards: boolean }
): Promise<{ addedCount: number; prioritizedCount: number }> {
  const batch = writeBatch(db);
  const nowIso = new Date().toISOString();
  const cleanProjectTag = clip(projectTag || 'Active Project', 80);

  let prioritizedCount = 0;
  for (const match of adapted.prioritizeExistingTitles) {
    const existing = skills.find(
      (s) => s.title.toLowerCase() === match.existingTitle.toLowerCase()
    );
    if (existing) {
      batch.update(doc(db, 'users', uid, 'skills', existing.id), {
        priority: match.priority,
        projectTag: cleanProjectTag,
        updatedAt: serverTimestamp(),
      });
      prioritizedCount += 1;
    }
  }

  let addedCount = 0;
  for (const topic of adapted.newTopics) {
    const duplicate = skills.find(
      (s) => s.title.toLowerCase() === topic.title.toLowerCase()
    );
    if (duplicate) {
      batch.update(doc(db, 'users', uid, 'skills', duplicate.id), {
        priority: topic.priority,
        projectTag: cleanProjectTag,
        studyBrief: clip(topic.studyBrief, 8000),
        labPrompt: clip(topic.labPrompt, 2000),
        updatedAt: serverTimestamp(),
      });
      prioritizedCount += 1;
    } else {
      const ref = doc(collection(db, 'users', uid, 'skills'));
      batch.set(ref, {
        userId: uid,
        domain: topic.domain,
        title: clip(topic.title, 160),
        tier: topic.tier,
        priority: topic.priority,
        projectTag: cleanProjectTag,
        mastery: 18,
        targetMastery: 95,
        description: clip(topic.description, 600),
        studyBrief: clip(topic.studyBrief, 8000),
        labPrompt: clip(topic.labPrompt, 2000),
        practiceCount: 0,
        lastPracticedAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      addedCount += 1;
    }
  }

  if (options.addSuggestedCards && adapted.suggestedCards.length > 0) {
    for (const card of adapted.suggestedCards.slice(0, 5)) {
      const cardRef = doc(collection(db, 'users', uid, 'reviewCards'));
      batch.set(cardRef, {
        userId: uid,
        domain: card.domain,
        skillTitle: clip(card.skillTitle, 160),
        prompt: clip(card.prompt, 2000),
        answer: clip(card.answer, 3000),
        explanation: clip(card.explanation, 3000),
        easeFactor: 2.5,
        intervalDays: 0,
        repetitions: 0,
        nextReviewAt: nowIso,
        lastReviewedAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  }

  if (options.adaptWeeklyRotation) {
    const orderSet = Array.from(
      new Set([...(adapted.recommendedWeeklyFocusOrder || []), ...DOMAINS])
    ).filter((d): d is Domain => DOMAINS.includes(d as Domain));

    const nextMap: Record<DayKey, RotationSlot> = {
      Mon: orderSet[0] || 'Angular',
      Tue: orderSet[1] || 'FastAPI',
      Wed: orderSet[2] || 'DevOps',
      Thu: orderSet[3] || 'AWS',
      Fri: orderSet[4] || 'GCP',
      Sat: 'Multi-Cloud Synthesis',
      Sun: 'Review & Gap Audit',
    };
    batch.update(doc(db, 'users', uid), {
      rotationMap: nextMap,
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    return { addedCount, prioritizedCount };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/skills`);
  }
}

export async function updateSkillMastery(
  uid: string,
  skill: SkillNode,
  nextMastery: number,
  incrementPractice = true
): Promise<void> {
  const path = `users/${uid}/skills/${skill.id}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'skills', skill.id), {
      mastery: Math.min(100, Math.max(0, Math.round(nextMastery))),
      practiceCount: incrementPractice ? skill.practiceCount + 1 : skill.practiceCount,
      lastPracticedAt: incrementPractice ? new Date().toISOString() : skill.lastPracticedAt,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function saveSkillBrief(
  uid: string,
  skillId: string,
  studyBrief: string,
  labPrompt: string
): Promise<void> {
  const path = `users/${uid}/skills/${skillId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'skills', skillId), {
      studyBrief: clip(studyBrief, 8000),
      labPrompt: clip(labPrompt, 2000),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteSkillNode(uid: string, skillId: string): Promise<void> {
  const path = `users/${uid}/skills/${skillId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'skills', skillId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function recordMappedWorkLog(
  uid: string,
  profile: UserProfile,
  skills: SkillNode[],
  payload: {
    projectName: string;
    taskSummary: string;
    minutesSpent: number;
    primaryDomain: Domain;
    domains: Domain[];
    extractedSkills: string[];
    matchedSkillTitles: string[];
    xpAwarded: number;
    elevationNote: string;
  }
): Promise<void> {
  const batch = writeBatch(db);
  const logRef = doc(collection(db, 'users', uid, 'workLogs'));
  const cleanDomains = (payload.domains.length ? payload.domains : [payload.primaryDomain]).slice(0, 5);

  batch.set(logRef, {
    userId: uid,
    projectName: clip(payload.projectName, 120),
    taskSummary: clip(payload.taskSummary, 2500),
    primaryDomain: payload.primaryDomain,
    domains: cleanDomains,
    extractedSkills: payload.extractedSkills.slice(0, 10).map((s) => clip(s, 120)),
    elevationNote: clip(payload.elevationNote, 3000),
    xpAwarded: Math.min(500, Math.max(0, Math.round(payload.xpAwarded))),
    minutesSpent: Math.min(1440, Math.max(1, Math.round(payload.minutesSpent))),
    createdAt: serverTimestamp(),
  });

  // Update matched skill nodes
  const nowIso = new Date().toISOString();
  const matchedNodes = skills.filter((s) =>
    payload.matchedSkillTitles.some(
      (title) => title.toLowerCase() === s.title.toLowerCase()
    )
  );
  const nodesToBoost =
    matchedNodes.length > 0
      ? matchedNodes.slice(0, 3)
      : skills.filter((s) => s.domain === payload.primaryDomain).slice(0, 1);

  const perSkillBoost = Math.max(3, Math.round(payload.xpAwarded / Math.max(1, nodesToBoost.length) / 5));

  for (const node of nodesToBoost) {
    const skillRef = doc(db, 'users', uid, 'skills', node.id);
    batch.update(skillRef, {
      mastery: Math.min(100, node.mastery + perSkillBoost),
      practiceCount: node.practiceCount + 1,
      lastPracticedAt: nowIso,
      updatedAt: serverTimestamp(),
    });
  }

  // Update user's focus minutes & streak
  const today = getTodayIsoDate();
  const nextFocusMinutes = { ...profile.domainFocusMinutes };
  nextFocusMinutes[payload.primaryDomain] =
    (nextFocusMinutes[payload.primaryDomain] || 0) + Math.max(1, Math.round(payload.minutesSpent));

  batch.update(doc(db, 'users', uid), {
    domainFocusMinutes: nextFocusMinutes,
    streakDays: profile.lastActiveDate !== today ? profile.streakDays + 1 : profile.streakDays,
    lastActiveDate: today,
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/workLogs`);
  }
}

export async function createIncidentDrill(
  uid: string,
  payload: {
    domain: string;
    title: string;
    difficulty: 'Senior' | 'Staff' | 'Principal';
    scenarioPrompt: string;
    initialChallenge: string;
  }
): Promise<string> {
  const path = `users/${uid}/drills`;
  try {
    const ref = doc(collection(db, path));
    await setDoc(ref, {
      userId: uid,
      domain: clip(payload.domain, 40),
      title: clip(payload.title, 180),
      difficulty: payload.difficulty,
      scenarioPrompt: clip(payload.scenarioPrompt, 4000),
      status: 'active',
      messages: [
        {
          role: 'assistant',
          content: clip(payload.initialChallenge, 3000),
          timestamp: new Date().toISOString(),
        },
      ],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function appendDrillMessages(
  uid: string,
  drillId: string,
  messages: DrillMessage[]
): Promise<void> {
  const path = `users/${uid}/drills/${drillId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'drills', drillId), {
      messages: messages.slice(-30),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function completeIncidentDrill(
  uid: string,
  drillId: string,
  messages: DrillMessage[],
  evaluation: DrillEvaluation
): Promise<void> {
  const path = `users/${uid}/drills/${drillId}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'drills', drillId), {
      messages: messages.slice(-30),
      status: 'completed',
      evaluation,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function createReviewCards(
  uid: string,
  cards: Array<{
    domain: Domain;
    skillTitle: string;
    prompt: string;
    answer: string;
    explanation: string;
  }>
): Promise<void> {
  const path = `users/${uid}/reviewCards`;
  try {
    const batch = writeBatch(db);
    const nowIso = new Date().toISOString();
    for (const c of cards) {
      const ref = doc(collection(db, path));
      batch.set(ref, {
        userId: uid,
        domain: c.domain,
        skillTitle: clip(c.skillTitle, 160),
        prompt: clip(c.prompt, 2000),
        answer: clip(c.answer, 3000),
        explanation: clip(c.explanation, 3000),
        easeFactor: 2.5,
        intervalDays: 0,
        repetitions: 0,
        nextReviewAt: nowIso,
        lastReviewedAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

// SM-2 Spaced Repetition calculation (quality: 1 = Again, 3 = Hard, 4 = Good, 5 = Easy)
export function calculateSm2(
  card: ReviewCard,
  quality: 1 | 3 | 4 | 5
): {
  easeFactor: number;
  intervalDays: number;
  repetitions: number;
  nextReviewAt: string;
} {
  let easeFactor = card.easeFactor;
  let repetitions = card.repetitions;
  let intervalDays = card.intervalDays;

  if (quality < 3) {
    repetitions = 0;
    intervalDays = 1;
  } else {
    if (repetitions === 0) {
      intervalDays = 1;
    } else if (repetitions === 1) {
      intervalDays = 6;
    } else {
      intervalDays = Math.round(intervalDays * easeFactor);
    }
    repetitions += 1;
  }

  easeFactor =
    easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  easeFactor = Math.min(5.0, Math.max(1.3, Number(easeFactor.toFixed(2))));

  const nextDate = new Date();
  nextDate.setDate(nextDate.getDate() + intervalDays);

  return {
    easeFactor,
    intervalDays: Math.min(3650, intervalDays),
    repetitions,
    nextReviewAt: nextDate.toISOString(),
  };
}

export async function gradeReviewCard(
  uid: string,
  card: ReviewCard,
  quality: 1 | 3 | 4 | 5
): Promise<void> {
  const path = `users/${uid}/reviewCards/${card.id}`;
  const next = calculateSm2(card, quality);
  try {
    await updateDoc(doc(db, 'users', uid, 'reviewCards', card.id), {
      easeFactor: next.easeFactor,
      intervalDays: next.intervalDays,
      repetitions: next.repetitions,
      nextReviewAt: next.nextReviewAt,
      lastReviewedAt: new Date().toISOString(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteReviewCard(uid: string, cardId: string): Promise<void> {
  const path = `users/${uid}/reviewCards/${cardId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'reviewCards', cardId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeAgentSessions(
  uid: string,
  onData: (sessions: AgentSession[]) => void
): Unsubscribe {
  const path = `users/${uid}/agentSessions`;
  const q = query(
    collection(db, path),
    where('userId', '==', uid),
    orderBy('updatedAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as AgentSession));
      onData(rows);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function createAgentSession(
  uid: string,
  title: string,
  projectContext: string,
  messages: AgentMessage[]
): Promise<string> {
  const path = `users/${uid}/agentSessions`;
  try {
    const ref = doc(collection(db, path));
    await setDoc(ref, {
      userId: uid,
      title: clip(title || 'Syllabus Structuring Session', 160),
      projectContext: clip(projectContext, 2000),
      messages: messages.slice(-30),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return ref.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function updateAgentSession(
  uid: string,
  sessionId: string,
  payload: {
    title?: string;
    projectContext: string;
    messages: AgentMessage[];
  }
): Promise<void> {
  const path = `users/${uid}/agentSessions/${sessionId}`;
  try {
    const updateBody: Record<string, unknown> = {
      projectContext: clip(payload.projectContext, 2000),
      messages: payload.messages.slice(-30),
      updatedAt: serverTimestamp(),
    };
    if (payload.title) {
      updateBody.title = clip(payload.title, 160);
    }
    await updateDoc(doc(db, 'users', uid, 'agentSessions', sessionId), updateBody);
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function deleteAgentSession(uid: string, sessionId: string): Promise<void> {
  const path = `users/${uid}/agentSessions/${sessionId}`;
  try {
    await deleteDoc(doc(db, 'users', uid, 'agentSessions', sessionId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export async function applyAgentSyllabusProposal(
  uid: string,
  skills: SkillNode[],
  session: AgentSession,
  messageIndex: number,
  proposal: SyllabusProposal
): Promise<{ added: number; updated: number; demotedOrRemoved: number; cardsAdded: number }> {
  const batch = writeBatch(db);
  const nowIso = new Date().toISOString();
  const defaultTag = clip(proposal.projectTag || 'Active Project', 80);

  let added = 0;
  let updated = 0;
  let demotedOrRemoved = 0;
  let cardsAdded = 0;

  // 1. Update existing topics (tier, priority, projectTag, and optional refreshed brief/lab)
  for (const item of proposal.updateTopics) {
    const existing = skills.find(
      (s) => s.title.toLowerCase() === item.existingTitle.toLowerCase()
    );
    if (!existing) continue;

    const patch: Record<string, unknown> = {
      tier: item.tier,
      priority: item.priority,
      projectTag: clip(item.projectTag || defaultTag, 80),
      updatedAt: serverTimestamp(),
    };
    if (item.updatedStudyBrief?.trim()) {
      patch.studyBrief = clip(item.updatedStudyBrief, 8000);
    }
    if (item.updatedLabPrompt?.trim()) {
      patch.labPrompt = clip(item.updatedLabPrompt, 2000);
    }

    batch.update(doc(db, 'users', uid, 'skills', existing.id), patch);
    updated += 1;
  }

  // 2. Add new structured topics (avoid duplicating existing titles)
  for (const topic of proposal.addTopics) {
    const duplicate = skills.find(
      (s) => s.title.toLowerCase() === topic.title.toLowerCase()
    );
    if (duplicate) {
      batch.update(doc(db, 'users', uid, 'skills', duplicate.id), {
        tier: topic.tier,
        priority: topic.priority,
        projectTag: defaultTag,
        studyBrief: clip(topic.studyBrief, 8000),
        labPrompt: clip(topic.labPrompt, 2000),
        updatedAt: serverTimestamp(),
      });
      updated += 1;
    } else {
      const ref = doc(collection(db, 'users', uid, 'skills'));
      batch.set(ref, {
        userId: uid,
        domain: topic.domain,
        title: clip(topic.title, 160),
        tier: topic.tier,
        priority: topic.priority,
        projectTag: defaultTag,
        mastery: 15,
        targetMastery: 95,
        description: clip(topic.description, 600),
        studyBrief: clip(topic.studyBrief, 8000),
        labPrompt: clip(topic.labPrompt, 2000),
        practiceCount: 0,
        lastPracticedAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      added += 1;
    }
  }

  // 3. Demote or remove obsolete topics
  for (const actionItem of proposal.removeOrDemoteTitles) {
    const existing = skills.find(
      (s) => s.title.toLowerCase() === actionItem.existingTitle.toLowerCase()
    );
    if (!existing) continue;
    if (actionItem.action === 'remove') {
      batch.delete(doc(db, 'users', uid, 'skills', existing.id));
    } else {
      batch.update(doc(db, 'users', uid, 'skills', existing.id), {
        priority: 'Normal',
        projectTag: '',
        updatedAt: serverTimestamp(),
      });
    }
    demotedOrRemoved += 1;
  }

  // 4. Add targeted SM-2 recall cards
  for (const card of proposal.newReviewCards.slice(0, 5)) {
    const cardRef = doc(collection(db, 'users', uid, 'reviewCards'));
    batch.set(cardRef, {
      userId: uid,
      domain: card.domain,
      skillTitle: clip(card.skillTitle, 160),
      prompt: clip(card.prompt, 2000),
      answer: clip(card.answer, 3000),
      explanation: clip(card.explanation, 3000),
      easeFactor: 2.5,
      intervalDays: 0,
      repetitions: 0,
      nextReviewAt: nowIso,
      lastReviewedAt: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    cardsAdded += 1;
  }

  // 5. Restructure Mon-Fri Weekly Rotation
  if (proposal.weeklyFocusOrder && proposal.weeklyFocusOrder.length > 0) {
    const orderSet = Array.from(
      new Set([...proposal.weeklyFocusOrder, ...DOMAINS])
    ).filter((d): d is Domain => DOMAINS.includes(d as Domain));

    const nextMap: Record<DayKey, RotationSlot> = {
      Mon: orderSet[0] || 'Angular',
      Tue: orderSet[1] || 'FastAPI',
      Wed: orderSet[2] || 'DevOps',
      Thu: orderSet[3] || 'AWS',
      Fri: orderSet[4] || 'GCP',
      Sat: 'Multi-Cloud Synthesis',
      Sun: 'Review & Gap Audit',
    };
    batch.update(doc(db, 'users', uid), {
      rotationMap: nextMap,
      updatedAt: serverTimestamp(),
    });
  }

  // 6. Mark proposal applied on the AgentSession message
  const nextMessages = session.messages.map((msg, idx) =>
    idx === messageIndex ? { ...msg, applied: true } : msg
  );
  batch.update(doc(db, 'users', uid, 'agentSessions', session.id), {
    messages: nextMessages.slice(-30),
    updatedAt: serverTimestamp(),
  });

  try {
    await batch.commit();
    return { added, updated, demotedOrRemoved, cardsAdded };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/agentSessions`);
  }
}

export function subscribeProjectMissions(
  uid: string,
  onData: (missions: ProjectMission[]) => void
): Unsubscribe {
  const path = `users/${uid}/projectMissions`;
  const q = query(
    collection(db, path),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ProjectMission));
      onData(rows);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export function subscribeDailyQuests(
  uid: string,
  onData: (quests: DailyQuest[]) => void
): Unsubscribe {
  const path = `users/${uid}/dailyQuests`;
  const q = query(
    collection(db, path),
    where('userId', '==', uid),
    orderBy('createdAt', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() } as DailyQuest));
      onData(rows);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function activateProjectMissionAndSyllabus(
  uid: string,
  rawTaskBrief: string,
  currentSkills: SkillNode[],
  existingTodayPendingQuests: DailyQuest[],
  aiPlan: SystemUploadProjectResult
): Promise<string> {
  const batch = writeBatch(db);
  const nowIso = new Date().toISOString();
  const todayKey = getTodayIsoDate();

  const cleanProjectName = nonEmptyClip(aiPlan?.projectName, 'Active Project Mission', 120);
  const cleanRawBrief = nonEmptyClip(rawTaskBrief, cleanProjectName, 5000);
  const cleanPrimaryDomain = safeDomain(aiPlan?.primaryDomain, 'AWS');
  const cleanDomains = Array.from(
    new Set([
      cleanPrimaryDomain,
      ...(Array.isArray(aiPlan?.domains) ? aiPlan.domains : []).map((d) =>
        safeDomain(d, cleanPrimaryDomain)
      ),
    ])
  ).slice(0, 5);
  const cleanRank = safeEnum(aiPlan?.rank, VALID_MISSION_RANKS, 'A-Rank');

  const missionRef = doc(collection(db, 'users', uid, 'projectMissions'));
  const linkedTitles = Array.from(
    new Set([
      ...(aiPlan?.existingSkillsToElevate || []).map((e) => clip(e?.existingTitle, 160)),
      ...(aiPlan?.newSkillNodes || []).map((n) => clip(n?.title, 160)),
    ])
  )
    .filter((t) => t.length > 0)
    .slice(0, 12);

  const cleanModules = (aiPlan?.masterSyllabusModules || [])
    .slice(0, 8)
    .map((m, idx) => ({
      title: nonEmptyClip(m?.title, `${cleanProjectName} Module ${idx + 1}`, 160),
      domain: safeDomain(m?.domain, cleanPrimaryDomain),
      tier: safeEnum(m?.tier, VALID_TIERS, 'Top 1%'),
      objective: nonEmptyClip(
        m?.objective,
        `Execute ${cleanProjectName} deliverables cleanly.`,
        400
      ),
      keyInternals: nonEmptyClip(
        m?.keyInternals,
        'Internals, failure modes, security boundaries, and telemetry.',
        600
      ),
      verificationCriteria: nonEmptyClip(
        m?.verificationCriteria,
        'Verified with tests and runtime observability.',
        400
      ),
    }));

  // 1. Create active ProjectMission
  batch.set(missionRef, {
    userId: uid,
    projectName: cleanProjectName,
    rawTaskBrief: cleanRawBrief,
    primaryDomain: cleanPrimaryDomain,
    domains: cleanDomains,
    status: 'active',
    rank: cleanRank,
    masteryGoal: nonEmptyClip(
      aiPlan?.masteryGoal,
      `Deliver ${cleanProjectName} with Top 1% ${cleanPrimaryDomain} engineering rigor.`,
      600
    ),
    linkedSkillTitles: linkedTitles,
    masterSyllabusModules: cleanModules,
    completedAt: '',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  // 2. Automatically elevate matching existing syllabus nodes
  const updatedSkillIds = new Set<string>();
  for (const item of aiPlan?.existingSkillsToElevate || []) {
    const title = clip(item?.existingTitle, 160);
    if (!title) continue;
    const existing = currentSkills.find((s) => s.title.toLowerCase() === title.toLowerCase());
    if (existing && !updatedSkillIds.has(existing.id)) {
      updatedSkillIds.add(existing.id);
      batch.update(doc(db, 'users', uid, 'skills', existing.id), {
        priority: safeEnum(item?.priority, VALID_PRIORITIES, 'High'),
        projectTag: clip(cleanProjectName, 80),
        updatedAt: serverTimestamp(),
      });
    }
  }

  // 3. Automatically inject new Top 1% / Senior skill nodes for this project
  for (const node of aiPlan?.newSkillNodes || []) {
    const nodeTitle = clip(node?.title, 160);
    if (!nodeTitle) continue;
    const nodePriority = safeEnum(node?.priority, VALID_PRIORITIES, 'Critical');
    const nodeTier = safeEnum(node?.tier, VALID_TIERS, 'Top 1%');
    const nodeDomain = safeDomain(node?.domain, cleanPrimaryDomain);
    const nodeStudyBrief = clip(node?.studyBrief, 8000);
    const nodeLabPrompt = clip(node?.labPrompt, 2000);

    const duplicate = currentSkills.find((s) => s.title.toLowerCase() === nodeTitle.toLowerCase());
    if (duplicate) {
      if (!updatedSkillIds.has(duplicate.id)) {
        updatedSkillIds.add(duplicate.id);
        batch.update(doc(db, 'users', uid, 'skills', duplicate.id), {
          priority: nodePriority,
          projectTag: clip(cleanProjectName, 80),
          studyBrief: nodeStudyBrief || duplicate.studyBrief || '',
          labPrompt: nodeLabPrompt || duplicate.labPrompt || '',
          updatedAt: serverTimestamp(),
        });
      }
    } else {
      const skillRef = doc(collection(db, 'users', uid, 'skills'));
      batch.set(skillRef, {
        userId: uid,
        domain: nodeDomain,
        title: nodeTitle,
        tier: nodeTier,
        priority: nodePriority,
        projectTag: clip(cleanProjectName, 80),
        mastery: 18,
        targetMastery: 95,
        description: clip(node?.description, 600),
        studyBrief: nodeStudyBrief,
        labPrompt: nodeLabPrompt,
        practiceCount: 0,
        lastPracticedAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  }

  // 4. Automatically prioritize project's domain at the front of weekly rotation
  const orderSet = Array.from(
    new Set([
      cleanPrimaryDomain,
      ...(Array.isArray(aiPlan?.weeklyFocusOrder) ? aiPlan.weeklyFocusOrder : []).map((d) =>
        safeDomain(d, cleanPrimaryDomain)
      ),
      ...DOMAINS,
    ])
  );

  const nextMap: Record<DayKey, RotationSlot> = {
    Mon: orderSet[0] || cleanPrimaryDomain,
    Tue: orderSet[1] || 'FastAPI',
    Wed: orderSet[2] || 'DevOps',
    Thu: orderSet[3] || 'AWS',
    Fri: orderSet[4] || 'GCP',
    Sat: 'Multi-Cloud Synthesis',
    Sun: 'Review & Gap Audit',
  };
  batch.update(doc(db, 'users', uid), {
    rotationMap: nextMap,
    updatedAt: serverTimestamp(),
  });

  // 5. Replace today's pending quests with Project Override quests
  for (const pending of existingTodayPendingQuests) {
    batch.delete(doc(db, 'users', uid, 'dailyQuests', pending.id));
  }

  for (const [idx, q] of (aiPlan?.dailyQuests || []).slice(0, 5).entries()) {
    const questRef = doc(collection(db, 'users', uid, 'dailyQuests'));
    const questDomain = safeDomain(q?.domain, cleanPrimaryDomain);
    const checklist = (Array.isArray(q?.masteryChecklist) ? q.masteryChecklist : [])
      .slice(0, 6)
      .map((c) => clip(c, 220))
      .filter((c) => c.length > 0);

    batch.set(questRef, {
      userId: uid,
      dateKey: nonEmptyClip(todayKey, getTodayIsoDate(), 16),
      mode: 'project_override',
      projectMissionId: missionRef.id,
      projectName: cleanProjectName,
      domain: questDomain,
      questType: safeEnum(
        q?.questType,
        VALID_QUEST_TYPES,
        VALID_QUEST_TYPES[idx % VALID_QUEST_TYPES.length]
      ),
      rank: safeEnum(q?.rank, VALID_QUEST_RANKS, 'B-Rank'),
      title: nonEmptyClip(q?.title, `${cleanProjectName} Quest ${idx + 1}`, 180),
      objective: nonEmptyClip(
        q?.objective,
        `Execute ${questDomain} engineering work for ${cleanProjectName}.`,
        1000
      ),
      masteryChecklist: checklist.length > 0 ? checklist : ['Execute primary deliverable', 'Verify edge cases'],
      linkedSkillTitle: clip(q?.linkedSkillTitle, 160),
      estimatedMinutes: Math.min(240, Math.max(5, Math.round(Number(q?.estimatedMinutes) || 45))),
      xpReward: Math.min(300, Math.max(10, Math.round(Number(q?.xpReward) || 60))),
      status: 'pending',
      completedAt: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  // 6. Queue targeted SM-2 review cards
  for (const card of (aiPlan?.suggestedCards || []).slice(0, 4)) {
    const cardPrompt = clip(card?.prompt, 2000);
    const cardAnswer = clip(card?.answer, 3000);
    if (!cardPrompt || !cardAnswer) continue;

    const cardRef = doc(collection(db, 'users', uid, 'reviewCards'));
    batch.set(cardRef, {
      userId: uid,
      domain: safeDomain(card?.domain, cleanPrimaryDomain),
      skillTitle: nonEmptyClip(card?.skillTitle, cleanProjectName, 160),
      prompt: cardPrompt,
      answer: cardAnswer,
      explanation: clip(card?.explanation, 3000),
      easeFactor: 2.5,
      intervalDays: 0,
      repetitions: 0,
      nextReviewAt: nowIso,
      lastReviewedAt: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
    return missionRef.id;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/projectMissions`);
  }
}

export async function saveGeneratedDailyQuests(
  uid: string,
  dateKey: string,
  mode: SystemMode,
  activeProject: ProjectMission | null,
  existingTodayPendingQuests: DailyQuest[],
  drafts: GeneratedQuestDraft[]
): Promise<void> {
  const batch = writeBatch(db);
  const fallbackDomain = safeDomain(activeProject?.primaryDomain, 'Angular');

  for (const pending of existingTodayPendingQuests) {
    batch.delete(doc(db, 'users', uid, 'dailyQuests', pending.id));
  }

  for (const [idx, q] of (drafts || []).slice(0, 5).entries()) {
    const questRef = doc(collection(db, 'users', uid, 'dailyQuests'));
    const questDomain = safeDomain(q?.domain, fallbackDomain);
    const checklist = (Array.isArray(q?.masteryChecklist) ? q.masteryChecklist : [])
      .slice(0, 6)
      .map((c) => clip(c, 220))
      .filter((c) => c.length > 0);

    batch.set(questRef, {
      userId: uid,
      dateKey: nonEmptyClip(dateKey, getTodayIsoDate(), 16),
      mode: mode === 'project_override' ? 'project_override' : 'normal_routine',
      projectMissionId: activeProject ? clip(activeProject.id, 128) : '',
      projectName: activeProject ? clip(activeProject.projectName, 120) : '',
      domain: questDomain,
      questType: safeEnum(
        q?.questType,
        VALID_QUEST_TYPES,
        VALID_QUEST_TYPES[idx % VALID_QUEST_TYPES.length]
      ),
      rank: safeEnum(q?.rank, VALID_QUEST_RANKS, 'B-Rank'),
      title: nonEmptyClip(q?.title, `${questDomain} Mastery Quest ${idx + 1}`, 180),
      objective: nonEmptyClip(
        q?.objective,
        `Advance Top 1% proficiency in ${questDomain}.`,
        1000
      ),
      masteryChecklist: checklist.length > 0 ? checklist : ['Review internals', 'Implement and verify'],
      linkedSkillTitle: clip(q?.linkedSkillTitle, 160),
      estimatedMinutes: Math.min(240, Math.max(5, Math.round(Number(q?.estimatedMinutes) || 40))),
      xpReward: Math.min(300, Math.max(10, Math.round(Number(q?.xpReward) || 50))),
      status: 'pending',
      completedAt: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/dailyQuests`);
  }
}

export async function completeDailyQuestAtomic(
  uid: string,
  profile: UserProfile,
  skills: SkillNode[],
  quest: DailyQuest,
  domainRoadmap?: DomainRoadmap | null
): Promise<{ roadmapStepSynced?: string }> {
  if (quest.status === 'completed') return {};

  const batch = writeBatch(db);
  const nowIso = new Date().toISOString();
  const today = getTodayIsoDate();
  let roadmapStepSynced: string | undefined;

  // 1. Mark DailyQuest completed (terminal lock)
  batch.update(doc(db, 'users', uid, 'dailyQuests', quest.id), {
    status: 'completed',
    completedAt: nowIso,
    updatedAt: serverTimestamp(),
  });

  // 2. Automatically boost mastery & reps on the linked SkillNode (or lowest mastery in domain)
  const linkedNode =
    skills.find((s) => s.title.toLowerCase() === quest.linkedSkillTitle.toLowerCase()) ||
    skills
      .filter((s) => s.domain === quest.domain)
      .sort((a, b) => a.mastery - b.mastery)[0];

  const masteryGain = Math.min(12, Math.max(4, Math.round(quest.xpReward / 12)));
  if (linkedNode) {
    batch.update(doc(db, 'users', uid, 'skills', linkedNode.id), {
      mastery: Math.min(100, linkedNode.mastery + masteryGain),
      practiceCount: linkedNode.practiceCount + 1,
      lastPracticedAt: nowIso,
      updatedAt: serverTimestamp(),
    });
  }

  // 3. Automatically update focus minutes & daily streak on UserProfile
  const nextFocusMinutes = { ...profile.domainFocusMinutes };
  nextFocusMinutes[quest.domain] =
    (nextFocusMinutes[quest.domain] || 0) + Math.max(5, quest.estimatedMinutes);

  batch.update(doc(db, 'users', uid), {
    domainFocusMinutes: nextFocusMinutes,
    streakDays: profile.lastActiveDate !== today ? profile.streakDays + 1 : profile.streakDays,
    lastActiveDate: today,
    updatedAt: serverTimestamp(),
  });

  // 4. Automatically record WorkLog entry for project quests so telemetry stays unified
  if (quest.mode === 'project_override' && quest.projectName) {
    const logRef = doc(collection(db, 'users', uid, 'workLogs'));
    batch.set(logRef, {
      userId: uid,
      projectName: clip(quest.projectName, 120),
      taskSummary: clip(`[System Quest] ${quest.title}: ${quest.objective}`, 2500),
      primaryDomain: quest.domain,
      domains: [quest.domain],
      extractedSkills: linkedNode ? [clip(linkedNode.title, 120)] : [clip(quest.questType, 120)],
      elevationNote: clip(
        `Completed ${quest.rank} ${quest.questType} quest (+${quest.xpReward} XP, +${masteryGain}% mastery on ${linkedNode?.title || quest.domain}).`,
        3000
      ),
      xpAwarded: Math.min(500, Math.max(10, quest.xpReward)),
      minutesSpent: Math.min(1440, Math.max(5, quest.estimatedMinutes)),
      createdAt: serverTimestamp(),
    });
  }

  // 5. Auto-sync matching uncompleted roadmap step in the quest's domain (if roadmap exists)
  if (domainRoadmap && domainRoadmap.domain === quest.domain) {
    const linkedLower = (quest.linkedSkillTitle || '').trim().toLowerCase();
    const questTokens = `${quest.title} ${quest.linkedSkillTitle} ${quest.objective}`
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4);

    let bestStepId: string | null = null;
    let bestScore = 0;

    for (const stage of domainRoadmap.stages) {
      for (const step of stage.steps) {
        if (step.completed) continue;
        const stLower = (step.skillTitle || '').trim().toLowerCase();
        const titleLower = step.title.trim().toLowerCase();
        let score = 0;
        if (linkedLower && (stLower === linkedLower || titleLower === linkedLower)) {
          score = 100;
        } else {
          const hay = `${step.title} ${step.skillTitle} ${step.description}`.toLowerCase();
          score = questTokens.filter((tok) => hay.includes(tok)).length;
        }
        if (score > bestScore) {
          bestScore = score;
          bestStepId = step.id;
        }
      }
    }

    if (bestStepId && bestScore >= 2) {
      const nextStages = domainRoadmap.stages.map((stage) => ({
        ...stage,
        steps: stage.steps.map((step) => {
          if (step.id !== bestStepId) return step;
          roadmapStepSynced = step.title;
          return {
            ...step,
            completed: true,
            completedAt: nowIso,
            completedJobTaskTag: clip(`Quest: ${quest.title}`, 80),
          };
        }),
      }));

      const nextRoadmap = buildCompactRoadmapPayload({
        ...domainRoadmap,
        stages: nextStages,
        updatedAtIso: nowIso,
      });

      const sessionId = `roadmap-${quest.domain}`;
      batch.update(doc(db, 'users', uid, 'agentSessions', sessionId), {
        title: nonEmptyClip(nextRoadmap.title, `Top 1% Roadmap — ${quest.domain}`, 160),
        projectContext: nonEmptyClip(
          `${nextRoadmap.targetRank} · ${nextRoadmap.visionSummary}`,
          `${quest.domain} roadmap architected by JARVIS`,
          1900
        ),
        messages: [
          {
            role: 'assistant',
            content: nextRoadmap.visionSummary || nextRoadmap.title,
            timestamp: nextRoadmap.updatedAtIso,
            roadmap: nextRoadmap,
          },
        ],
        updatedAt: serverTimestamp(),
      });
    }
  }

  try {
    await batch.commit();
    return { roadmapStepSynced };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/dailyQuests/${quest.id}`);
  }
}

export async function completeProjectMissionAndResumeRoutine(
  uid: string,
  profile: UserProfile,
  skills: SkillNode[],
  mission: ProjectMission,
  pendingProjectQuests: DailyQuest[]
): Promise<void> {
  const batch = writeBatch(db);
  const nowIso = new Date().toISOString();

  // 1. Mark mission completed
  batch.update(doc(db, 'users', uid, 'projectMissions', mission.id), {
    status: 'completed',
    completedAt: nowIso,
    updatedAt: serverTimestamp(),
  });

  // 2. Return project-tagged syllabus nodes back to Normal routine priority (preserving learned nodes & mastery!)
  for (const skill of skills) {
    const matchesTag =
      (skill.projectTag || '').toLowerCase() === mission.projectName.toLowerCase();
    const matchesTitle = mission.linkedSkillTitles.some(
      (t) => t.toLowerCase() === skill.title.toLowerCase()
    );
    if (matchesTag || matchesTitle) {
      batch.update(doc(db, 'users', uid, 'skills', skill.id), {
        priority: 'Normal',
        projectTag: '',
        updatedAt: serverTimestamp(),
      });
    }
  }

  // 3. Rebalance weekly rotation back to Normal Balanced 5-Domain Routine (lowest mastery first)
  const scores = DOMAINS.map((domain) => {
    const domSkills = skills.filter((s) => s.domain === domain);
    const avgMastery =
      domSkills.length > 0
        ? domSkills.reduce((acc, s) => acc + s.mastery, 0) / domSkills.length
        : 50;
    const minutes = profile.domainFocusMinutes[domain] || 0;
    return { domain, priority: avgMastery + minutes * 0.15 };
  }).sort((a, b) => a.priority - b.priority);

  const normalMap: Record<DayKey, RotationSlot> = {
    Mon: scores[0].domain,
    Tue: scores[1].domain,
    Wed: scores[2].domain,
    Thu: scores[3].domain,
    Fri: scores[4].domain,
    Sat: 'Multi-Cloud Synthesis',
    Sun: 'Review & Gap Audit',
  };

  batch.update(doc(db, 'users', uid), {
    rotationMap: normalMap,
    updatedAt: serverTimestamp(),
  });

  // 4. Clear stale pending project override quests so Normal Routine quests auto-generate immediately
  for (const q of pendingProjectQuests) {
    batch.delete(doc(db, 'users', uid, 'dailyQuests', q.id));
  }

  try {
    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/projectMissions/${mission.id}`);
  }
}

export async function applyJarvisSyllabusStructure(
  uid: string,
  skills: SkillNode[],
  plan: {
    weeklyFocusOrder?: Domain[];
    addTopics?: Array<{
      domain: Domain;
      title: string;
      tier: SkillTier;
      priority: SkillPriority;
      description: string;
      studyBrief: string;
      labPrompt: string;
    }>;
    updateTopics?: Array<{
      existingTitle: string;
      tier?: SkillTier;
      priority?: SkillPriority;
      projectTag?: string;
      updatedStudyBrief?: string;
      updatedLabPrompt?: string;
    }>;
    newReviewCards?: Array<{
      domain: Domain;
      skillTitle: string;
      prompt: string;
      answer: string;
      explanation: string;
    }>;
  }
): Promise<{ added: number; updated: number; cardsAdded: number }> {
  const batch = writeBatch(db);
  const nowIso = new Date().toISOString();
  const touchedSkillIds = new Set<string>();
  let added = 0;
  let updated = 0;
  let cardsAdded = 0;

  // 1. Update existing syllabus nodes (tier, priority, projectTag, studyBrief, labPrompt)
  for (const item of (plan.updateTopics || []).slice(0, 10)) {
    const title = clip(item.existingTitle, 160);
    if (!title) continue;
    const existing = skills.find((s) => s.title.toLowerCase() === title.toLowerCase());
    if (!existing || touchedSkillIds.has(existing.id)) continue;

    touchedSkillIds.add(existing.id);
    const patch: Record<string, unknown> = {
      tier: safeEnum(item.tier, VALID_TIERS, existing.tier),
      priority: safeEnum(item.priority, VALID_PRIORITIES, existing.priority || 'High'),
      projectTag: clip(item.projectTag ?? existing.projectTag ?? '', 80),
      updatedAt: serverTimestamp(),
    };
    if (item.updatedStudyBrief?.trim()) {
      patch.studyBrief = clip(item.updatedStudyBrief, 8000);
    }
    if (item.updatedLabPrompt?.trim()) {
      patch.labPrompt = clip(item.updatedLabPrompt, 2000);
    }

    batch.update(doc(db, 'users', uid, 'skills', existing.id), patch);
    updated += 1;
  }

  // 2. Add new Top 1% / Senior syllabus nodes (or upgrade existing if title matches)
  for (const topic of (plan.addTopics || []).slice(0, 8)) {
    const title = clip(topic.title, 160);
    if (!title) continue;
    const domain = safeDomain(topic.domain, 'AWS');
    const tier = safeEnum(topic.tier, VALID_TIERS, 'Top 1%');
    const priority = safeEnum(topic.priority, VALID_PRIORITIES, 'High');
    const description = nonEmptyClip(
      topic.description,
      `Top 1% engineering mastery module for ${domain}.`,
      600
    );
    const studyBrief = clip(topic.studyBrief, 8000);
    const labPrompt = clip(topic.labPrompt, 2000);

    const duplicate = skills.find((s) => s.title.toLowerCase() === title.toLowerCase());
    if (duplicate) {
      if (!touchedSkillIds.has(duplicate.id)) {
        touchedSkillIds.add(duplicate.id);
        batch.update(doc(db, 'users', uid, 'skills', duplicate.id), {
          tier,
          priority,
          projectTag: clip(duplicate.projectTag || '', 80),
          studyBrief: studyBrief || duplicate.studyBrief || '',
          labPrompt: labPrompt || duplicate.labPrompt || '',
          updatedAt: serverTimestamp(),
        });
        updated += 1;
      }
    } else {
      const ref = doc(collection(db, 'users', uid, 'skills'));
      batch.set(ref, {
        userId: uid,
        domain,
        title,
        tier,
        priority,
        projectTag: '',
        mastery: 15,
        targetMastery: 95,
        description,
        studyBrief,
        labPrompt,
        practiceCount: 0,
        lastPracticedAt: '',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      added += 1;
    }
  }

  // 3. Reorder Mon-Fri Weekly Rotation when provided
  if (Array.isArray(plan.weeklyFocusOrder) && plan.weeklyFocusOrder.length > 0) {
    const orderSet = Array.from(
      new Set([
        ...plan.weeklyFocusOrder.map((d) => safeDomain(d, 'AWS')),
        ...DOMAINS,
      ])
    );
    const nextMap: Record<DayKey, RotationSlot> = {
      Mon: orderSet[0] || 'Angular',
      Tue: orderSet[1] || 'FastAPI',
      Wed: orderSet[2] || 'DevOps',
      Thu: orderSet[3] || 'AWS',
      Fri: orderSet[4] || 'GCP',
      Sat: 'Multi-Cloud Synthesis',
      Sun: 'Review & Gap Audit',
    };
    batch.update(doc(db, 'users', uid), {
      rotationMap: nextMap,
      updatedAt: serverTimestamp(),
    });
  }

  // 4. Queue targeted SM-2 recall cards
  for (const card of (plan.newReviewCards || []).slice(0, 5)) {
    const prompt = clip(card.prompt, 2000);
    const answer = clip(card.answer, 3000);
    if (!prompt || !answer) continue;

    const cardRef = doc(collection(db, 'users', uid, 'reviewCards'));
    batch.set(cardRef, {
      userId: uid,
      domain: safeDomain(card.domain, 'AWS'),
      skillTitle: nonEmptyClip(card.skillTitle, 'Top 1% Architecture', 160),
      prompt,
      answer,
      explanation: clip(card.explanation, 3000),
      easeFactor: 2.5,
      intervalDays: 0,
      repetitions: 0,
      nextReviewAt: nowIso,
      lastReviewedAt: '',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    cardsAdded += 1;
  }

  if (added === 0 && updated === 0 && cardsAdded === 0 && !plan.weeklyFocusOrder?.length) {
    return { added: 0, updated: 0, cardsAdded: 0 };
  }

  try {
    await batch.commit();
    return { added, updated, cardsAdded };
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/skills`);
  }
}

export async function awardSkillPracticeFromJarvis(
  uid: string,
  skills: SkillNode[],
  skillTitle: string,
  domain?: Domain,
  masteryBoost = 6
): Promise<SkillNode | null> {
  const lower = (skillTitle || '').trim().toLowerCase();
  const target =
    skills.find((s) => s.title.toLowerCase() === lower) ||
    skills.find(
      (s) =>
        lower.length > 0 &&
        (s.title.toLowerCase().includes(lower) || lower.includes(s.title.toLowerCase()))
    ) ||
    (domain
      ? skills.filter((s) => s.domain === domain).sort((a, b) => a.mastery - b.mastery)[0]
      : undefined);

  if (!target) return null;

  const boost = Math.min(12, Math.max(2, Math.round(masteryBoost)));
  const path = `users/${uid}/skills/${target.id}`;
  try {
    await updateDoc(doc(db, 'users', uid, 'skills', target.id), {
      mastery: Math.min(100, target.mastery + boost),
      practiceCount: target.practiceCount + 1,
      lastPracticedAt: new Date().toISOString(),
      updatedAt: serverTimestamp(),
    });
    return target;
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export function subscribeDomainRoadmaps(
  uid: string,
  onData: (roadmaps: Partial<Record<Domain, DomainRoadmap>>) => void
): Unsubscribe {
  const path = `users/${uid}/agentSessions`;
  const q = query(collection(db, path), where('userId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const result: Partial<Record<Domain, DomainRoadmap>> = {};
      for (const docSnap of snap.docs) {
        if (!docSnap.id.startsWith('roadmap-')) continue;
        const data = docSnap.data() as {
          messages?: Array<{ roadmap?: DomainRoadmap }>;
        };
        const stored = data.messages?.[0]?.roadmap;
        if (stored && DOMAINS.includes(stored.domain)) {
          result[stored.domain] = { ...stored, id: docSnap.id };
        }
      }
      onData(result);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

function buildCompactRoadmapPayload(roadmap: DomainRoadmap): DomainRoadmap {
  return {
    id: `roadmap-${roadmap.domain}`,
    domain: roadmap.domain,
    title: nonEmptyClip(roadmap.title, `${roadmap.domain} Top 1% Mastery Roadmap`, 160),
    designedBy: 'JARVIS',
    visionSummary: clip(roadmap.visionSummary, 800),
    targetRank: nonEmptyClip(roadmap.targetRank, 'Top 1% Principal', 80),
    stages: (roadmap.stages || []).slice(0, 4).map((st, sIdx) => ({
      stageNumber: st.stageNumber || sIdx + 1,
      title: nonEmptyClip(st.title, `Stage ${sIdx + 1}`, 120),
      targetTier: safeEnum(st.targetTier, VALID_TIERS, 'Top 1%'),
      milestoneGoal: clip(st.milestoneGoal, 300),
      steps: (st.steps || []).slice(0, 4).map((step, stIdx) => ({
        id: nonEmptyClip(step.id, `s${sIdx + 1}-${stIdx + 1}`, 40),
        title: nonEmptyClip(step.title, `${roadmap.domain} Step ${stIdx + 1}`, 140),
        skillTitle: nonEmptyClip(step.skillTitle || step.title, `${roadmap.domain} Core`, 160),
        description: clip(step.description, 1200),
        detailedGuide: clip(step.detailedGuide || '', 1600),
        keyPitfalls: (step.keyPitfalls || [])
          .slice(0, 3)
          .map((p) => clip(p, 240))
          .filter(Boolean),
        deliverables: (step.deliverables || [])
          .slice(0, 4)
          .map((d) => clip(d, 180))
          .filter(Boolean),
        labObjective: clip(step.labObjective, 400),
        completed: Boolean(step.completed),
        completedAt: clip(step.completedAt || '', 48),
        completedJobTaskTag: clip(step.completedJobTaskTag || '', 80),
      })),
    })),
    completedJobTasks: Array.from(new Set(roadmap.completedJobTasks || []))
      .map((t) => clip(t, 120))
      .filter(Boolean)
      .slice(-20),
    updatedAtIso: new Date().toISOString(),
  };
}

export async function saveDomainRoadmap(
  uid: string,
  roadmap: DomainRoadmap,
  currentSkills: SkillNode[],
  alreadyExists = false
): Promise<void> {
  const cleanRoadmap = buildCompactRoadmapPayload(roadmap);
  const sessionId = `roadmap-${cleanRoadmap.domain}`;
  const path = `users/${uid}/agentSessions/${sessionId}`;

  const docTitle = nonEmptyClip(cleanRoadmap.title, `Top 1% Roadmap — ${cleanRoadmap.domain}`, 160);
  const docContext = nonEmptyClip(
    `${cleanRoadmap.targetRank} · ${cleanRoadmap.visionSummary}`,
    `${cleanRoadmap.domain} roadmap architected by JARVIS`,
    1900
  );
  const messageEntry = {
    role: 'assistant',
    content: cleanRoadmap.visionSummary || docTitle,
    timestamp: cleanRoadmap.updatedAtIso,
    roadmap: cleanRoadmap,
  };

  try {
    const ref = doc(db, 'users', uid, 'agentSessions', sessionId);
    const updatePayload = {
      title: docTitle,
      projectContext: docContext,
      messages: [messageEntry],
      updatedAt: serverTimestamp(),
    };
    const createPayload = {
      userId: uid,
      title: docTitle,
      projectContext: docContext,
      messages: [messageEntry],
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };

    if (alreadyExists) {
      try {
        await updateDoc(ref, updatePayload);
      } catch (updateErr) {
        const code = (updateErr as { code?: string })?.code || '';
        if (code === 'not-found' || code.includes('not-found')) {
          await setDoc(ref, createPayload);
        } else {
          throw updateErr;
        }
      }
    } else {
      try {
        await setDoc(ref, createPayload);
      } catch (createErr) {
        try {
          await updateDoc(ref, updatePayload);
        } catch {
          throw createErr;
        }
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }

  // Seed up to 4 missing SkillNodes from the roadmap steps so skill mastery & roadmap stay unified
  const existingTitlesLower = new Set(currentSkills.map((s) => s.title.toLowerCase()));
  const toCreate: Array<{
    title: string;
    tier: SkillTier;
    description: string;
    studyBrief: string;
    labPrompt: string;
    completed: boolean;
  }> = [];

  for (const stage of cleanRoadmap.stages) {
    for (const step of stage.steps) {
      if (toCreate.length >= 4) break;
      const skTitle = clip(step.skillTitle || step.title, 160);
      if (!skTitle || existingTitlesLower.has(skTitle.toLowerCase())) continue;
      existingTitlesLower.add(skTitle.toLowerCase());
      const richStudyBrief = [
        step.description,
        step.detailedGuide,
        step.deliverables?.length
          ? `Deliverables:\n${step.deliverables.map((d) => `• ${d}`).join('\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      toCreate.push({
        title: skTitle,
        tier: stage.targetTier,
        description: nonEmptyClip(step.description, `Roadmap milestone in ${cleanRoadmap.domain}`, 600),
        studyBrief: nonEmptyClip(richStudyBrief, step.description || skTitle, 8000),
        labPrompt: nonEmptyClip(
          step.labObjective,
          `Implement and verify ${skTitle} in ${cleanRoadmap.domain}.`,
          2000
        ),
        completed: step.completed,
      });
    }
    if (toCreate.length >= 4) break;
  }

  if (toCreate.length > 0) {
    try {
      const batch = writeBatch(db);
      const nowIso = new Date().toISOString();
      for (const item of toCreate) {
        const skillRef = doc(collection(db, 'users', uid, 'skills'));
        batch.set(skillRef, {
          userId: uid,
          domain: cleanRoadmap.domain,
          title: item.title,
          tier: item.tier,
          priority: item.completed ? 'Normal' : 'High',
          projectTag: '',
          mastery: item.completed ? 82 : 20,
          targetMastery: 95,
          description: item.description,
          studyBrief: item.studyBrief,
          labPrompt: item.labPrompt,
          practiceCount: item.completed ? 1 : 0,
          lastPracticedAt: item.completed ? nowIso : '',
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `users/${uid}/skills`);
    }
  }
}

export function subscribeJarvisThread(
  uid: string,
  onData: (messages: JarvisMessage[], existsInDb: boolean) => void
): Unsubscribe {
  const path = `users/${uid}/agentSessions`;
  const q = query(collection(db, path), where('userId', '==', uid));
  return onSnapshot(
    q,
    (snap) => {
      const threadDoc = snap.docs.find((d) => d.id === 'jarvis-mentor');
      if (!threadDoc) {
        onData([], false);
        return;
      }
      const data = threadDoc.data() as { messages?: JarvisMessage[] };
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      onData(msgs, true);
    },
    (error) => handleFirestoreError(error, OperationType.LIST, path)
  );
}

export async function saveJarvisThread(
  uid: string,
  messages: JarvisMessage[],
  alreadyExists: boolean
): Promise<void> {
  const sessionId = 'jarvis-mentor';
  const path = `users/${uid}/agentSessions/${sessionId}`;
  const compactMessages = messages.slice(-24).map((m) => ({
    id: nonEmptyClip(m.id, `m-${Date.now()}`, 64),
    role: m.role === 'user' ? 'user' : 'assistant',
    content: nonEmptyClip(m.content, '...', 3500),
    ...(m.headline ? { headline: clip(m.headline, 120) } : {}),
    ...(m.codeSnippet ? { codeSnippet: clip(m.codeSnippet, 3000) } : {}),
    ...(m.interactiveMode ? { interactiveMode: m.interactiveMode } : {}),
    ...(m.executedActions?.length
      ? { executedActions: m.executedActions.slice(0, 6).map((a) => clip(a, 140)) }
      : {}),
    ...(m.suggestedFollowUps?.length
      ? { suggestedFollowUps: m.suggestedFollowUps.slice(0, 4).map((f) => clip(f, 120)) }
      : {}),
    timestamp: nonEmptyClip(m.timestamp, new Date().toISOString(), 48),
  }));

  const ref = doc(db, 'users', uid, 'agentSessions', sessionId);
  const updatePayload = {
    title: 'JARVIS Mentor Thread',
    projectContext: 'Persistent 5-domain Top 1% coaching session',
    messages: compactMessages,
    updatedAt: serverTimestamp(),
  };
  const createPayload = {
    userId: uid,
    title: 'JARVIS Mentor Thread',
    projectContext: 'Persistent 5-domain Top 1% coaching session',
    messages: compactMessages,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  try {
    if (alreadyExists) {
      try {
        await updateDoc(ref, updatePayload);
      } catch (updateErr) {
        const code = (updateErr as { code?: string })?.code || '';
        if (code === 'not-found' || code.includes('not-found')) {
          await setDoc(ref, createPayload);
        } else {
          throw updateErr;
        }
      }
    } else {
      try {
        await setDoc(ref, createPayload);
      } catch (createErr) {
        try {
          await updateDoc(ref, updatePayload);
        } catch {
          throw createErr;
        }
      }
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function toggleRoadmapStepCompletion(
  uid: string,
  roadmap: DomainRoadmap,
  stepId: string,
  skills: SkillNode[]
): Promise<{ completedNow: boolean; stepTitle: string }> {
  const nowIso = new Date().toISOString();
  let completedNow = false;
  let stepTitle = '';
  let linkedSkillTitle = '';

  const nextStages = roadmap.stages.map((stage) => ({
    ...stage,
    steps: stage.steps.map((step) => {
      if (step.id !== stepId) return step;
      completedNow = !step.completed;
      stepTitle = step.title;
      linkedSkillTitle = step.skillTitle || step.title;
      return {
        ...step,
        completed: completedNow,
        completedAt: completedNow ? nowIso : '',
      };
    }),
  }));

  const nextRoadmap = buildCompactRoadmapPayload({
    ...roadmap,
    stages: nextStages,
    updatedAtIso: nowIso,
  });

  const sessionId = `roadmap-${nextRoadmap.domain}`;
  const path = `users/${uid}/agentSessions/${sessionId}`;

  try {
    await updateDoc(doc(db, 'users', uid, 'agentSessions', sessionId), {
      title: nonEmptyClip(nextRoadmap.title, `Top 1% Roadmap — ${nextRoadmap.domain}`, 160),
      projectContext: nonEmptyClip(
        `${nextRoadmap.targetRank} · ${nextRoadmap.visionSummary}`,
        `${nextRoadmap.domain} roadmap architected by JARVIS`,
        1900
      ),
      messages: [
        {
          role: 'assistant',
          content: nextRoadmap.visionSummary || nextRoadmap.title,
          timestamp: nextRoadmap.updatedAtIso,
          roadmap: nextRoadmap,
        },
      ],
      updatedAt: serverTimestamp(),
    });

    if (completedNow) {
      const lower = linkedSkillTitle.toLowerCase();
      const matched =
        skills.find((s) => s.title.toLowerCase() === lower) ||
        skills.find(
          (s) =>
            s.domain === nextRoadmap.domain &&
            (s.title.toLowerCase().includes(lower) || lower.includes(s.title.toLowerCase()))
        ) ||
        skills
          .filter((s) => s.domain === nextRoadmap.domain)
          .sort((a, b) => a.mastery - b.mastery)[0];

      if (matched) {
        await updateDoc(doc(db, 'users', uid, 'skills', matched.id), {
          mastery: Math.min(100, Math.max(matched.mastery + 10, 78)),
          practiceCount: matched.practiceCount + 1,
          lastPracticedAt: nowIso,
          updatedAt: serverTimestamp(),
        });
      }
    }

    return { completedNow, stepTitle };
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function markJobTaskDoneAndResumePath(
  uid: string,
  profile: UserProfile,
  skills: SkillNode[],
  roadmaps: Partial<Record<Domain, DomainRoadmap>>,
  params: {
    jobTitle: string;
    taskSummary: string;
    domain: Domain;
    extractedSkills?: string[];
    matchedSkillTitles?: string[];
    elevationNote?: string;
    xpAwarded?: number;
    minutesSpent?: number;
    activeProject?: ProjectMission | null;
    pendingProjectQuests?: DailyQuest[];
    markActiveProjectDone?: boolean;
  }
): Promise<{ stepsCompletedCount: number; exitedOverride: boolean }> {
  const cleanJobTitle = nonEmptyClip(params.jobTitle, 'Prior Job Task', 120);
  const cleanDomain = safeDomain(params.domain, 'AWS');
  const nowIso = new Date().toISOString();
  let exitedOverride = false;

  // 1. If an active Project Override exists (e.g., completing an active job task or clearing it to resume normal path)
  if (params.activeProject && params.markActiveProjectDone !== false) {
    await completeProjectMissionAndResumeRoutine(
      uid,
      profile,
      skills,
      params.activeProject,
      params.pendingProjectQuests || []
    );
    exitedOverride = true;
  }

  // 2. Record completed WorkLog + boost matched skills + update focus minutes & streak
  const xpAwarded = Math.min(500, Math.max(40, Math.round(params.xpAwarded ?? 120)));
  const minutesSpent = Math.min(1440, Math.max(15, Math.round(params.minutesSpent ?? 60)));

  const matchedTitlesLower = new Set(
    (params.matchedSkillTitles || []).map((t) => t.toLowerCase())
  );
  const jobTokens = cleanJobTitle
    .toLowerCase()
    .concat(' ', (params.taskSummary || '').toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4);

  const matchedNodes = skills
    .filter((s) => {
      if (matchedTitlesLower.has(s.title.toLowerCase())) return true;
      if (s.domain !== cleanDomain) return false;
      return jobTokens.some((tok) => s.title.toLowerCase().includes(tok));
    })
    .slice(0, 3);

  const nodesToBoost =
    matchedNodes.length > 0
      ? matchedNodes
      : skills
          .filter((s) => s.domain === cleanDomain)
          .sort((a, b) => a.mastery - b.mastery)
          .slice(0, 2);

  try {
    const batch = writeBatch(db);
    const logRef = doc(collection(db, 'users', uid, 'workLogs'));
    batch.set(logRef, {
      userId: uid,
      projectName: cleanJobTitle,
      taskSummary: nonEmptyClip(
        params.taskSummary,
        `Marked job task "${cleanJobTitle}" completed (${cleanDomain}) and resumed normal learning path.`,
        2500
      ),
      primaryDomain: cleanDomain,
      domains: [cleanDomain],
      extractedSkills: (params.extractedSkills && params.extractedSkills.length > 0
        ? params.extractedSkills
        : nodesToBoost.map((n) => n.title)
      )
        .slice(0, 10)
        .map((s) => clip(s, 120)),
      elevationNote: clip(
        params.elevationNote ||
          `Verified prior job completion for "${cleanJobTitle}" (+${xpAwarded} XP). Mastery credited and learning path resumed.`,
        3000
      ),
      xpAwarded,
      minutesSpent,
      createdAt: serverTimestamp(),
    });

    for (const node of nodesToBoost) {
      batch.update(doc(db, 'users', uid, 'skills', node.id), {
        mastery: Math.min(100, Math.max(node.mastery + 10, 78)),
        practiceCount: node.practiceCount + 1,
        lastPracticedAt: nowIso,
        updatedAt: serverTimestamp(),
      });
    }

    const today = getTodayIsoDate();
    const nextFocusMinutes = { ...profile.domainFocusMinutes };
    nextFocusMinutes[cleanDomain] = (nextFocusMinutes[cleanDomain] || 0) + minutesSpent;

    batch.update(doc(db, 'users', uid), {
      domainFocusMinutes: nextFocusMinutes,
      streakDays: profile.lastActiveDate !== today ? profile.streakDays + 1 : profile.streakDays,
      lastActiveDate: today,
      updatedAt: serverTimestamp(),
    });

    await batch.commit();
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, `users/${uid}/workLogs`);
  }

  // 3. Mark matching uncompleted step(s) done in the domain's JARVIS Roadmap if saved
  let stepsCompletedCount = 0;
  const domainRoadmap = roadmaps[cleanDomain];
  if (domainRoadmap) {
    const allSteps = domainRoadmap.stages.flatMap((st) => st.steps);
    const uncompleted = allSteps.filter((st) => !st.completed);

    const scoredSteps = uncompleted
      .map((st) => {
        const hay = `${st.title} ${st.skillTitle} ${st.description}`.toLowerCase();
        const hits = jobTokens.filter((tok) => hay.includes(tok)).length;
        return { stepId: st.id, hits };
      })
      .sort((a, b) => b.hits - a.hits);

    const targetIds = new Set<string>();
    for (const candidate of scoredSteps) {
      if (targetIds.size >= 2) break;
      if (candidate.hits > 0 || targetIds.size === 0) {
        targetIds.add(candidate.stepId);
      }
    }

    const nextStages = domainRoadmap.stages.map((st) => ({
      ...st,
      steps: st.steps.map((step) => {
        if (!targetIds.has(step.id)) return step;
        stepsCompletedCount += 1;
        return {
          ...step,
          completed: true,
          completedAt: nowIso,
          completedJobTaskTag: cleanJobTitle,
        };
      }),
    }));

    const nextRoadmap = buildCompactRoadmapPayload({
      ...domainRoadmap,
      stages: nextStages,
      completedJobTasks: [...(domainRoadmap.completedJobTasks || []), cleanJobTitle],
      updatedAtIso: nowIso,
    });

    const sessionId = `roadmap-${cleanDomain}`;
    try {
      await updateDoc(doc(db, 'users', uid, 'agentSessions', sessionId), {
        title: nonEmptyClip(nextRoadmap.title, `Top 1% Roadmap — ${cleanDomain}`, 160),
        projectContext: nonEmptyClip(
          `${nextRoadmap.targetRank} · ${nextRoadmap.visionSummary}`,
          `${cleanDomain} roadmap architected by JARVIS`,
          1900
        ),
        messages: [
          {
            role: 'assistant',
            content: nextRoadmap.visionSummary || nextRoadmap.title,
            timestamp: nextRoadmap.updatedAtIso,
            roadmap: nextRoadmap,
          },
        ],
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `users/${uid}/agentSessions/${sessionId}`);
    }
  }

  return { stepsCompletedCount, exitedOverride };
}




