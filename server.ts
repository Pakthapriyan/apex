import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  Behavior,
  FunctionDeclaration,
  FunctionResponseScheduling,
  GoogleGenAI,
  InteractionStatus,
  LiveServerMessage,
  Modality,
  ThinkingLevel,
  Type,
} from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT) || 3000;

function getAiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function getLiveAiClient(apiVersion = 'v1alpha'): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      apiVersion,
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function handleAiError(res: express.Response, error: unknown, context: string) {
  console.error(`[AI Error - ${context}]:`, error);
  let message = error instanceof Error ? error.message : 'Unexpected AI service error';
  try {
    const parsed = JSON.parse(message) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      message = parsed.error.message;
    }
  } catch {
    // Keep original message when not serialized JSON
  }
  const status = message.includes('GEMINI_API_KEY') ? 500 : 502;
  res.status(status).json({ error: message });
}

type Domain = 'Angular' | 'FastAPI' | 'DevOps' | 'AWS' | 'GCP';
type SkillTier = 'Foundational' | 'Senior' | 'Top 1%';
type SkillPriority = 'Critical' | 'High' | 'Normal';
type MissionRank = 'C-Rank' | 'B-Rank' | 'A-Rank' | 'S-Rank';
type QuestRank = 'E-Rank' | 'D-Rank' | 'C-Rank' | 'B-Rank' | 'A-Rank' | 'S-Rank';
type QuestType = 'Project Execution' | 'Domain Mastery' | 'Production Drill' | 'Active Recall';

const VALID_DOMAINS: Domain[] = ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'];
const VALID_TIERS: SkillTier[] = ['Foundational', 'Senior', 'Top 1%'];
const VALID_PRIORITIES: SkillPriority[] = ['Critical', 'High', 'Normal'];
const VALID_MISSION_RANKS: MissionRank[] = ['C-Rank', 'B-Rank', 'A-Rank', 'S-Rank'];
const VALID_QUEST_RANKS: QuestRank[] = ['E-Rank', 'D-Rank', 'C-Rank', 'B-Rank', 'A-Rank', 'S-Rank'];
const VALID_QUEST_TYPES: QuestType[] = [
  'Project Execution',
  'Domain Mastery',
  'Production Drill',
  'Active Recall',
];

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function inferDomainFromText(text: string): Domain {
  const lower = text.toLowerCase();
  const scores: Record<Domain, number> = {
    Angular: 0,
    FastAPI: 0,
    DevOps: 0,
    AWS: 0,
    GCP: 0,
  };

  const patterns: Array<[Domain, RegExp]> = [
    ['AWS', /\b(aws|sqs|s3|eks|rds|alb|iam|irsa|cloudfront|cloudwatch|ec2|lambda|ecs)\b/g],
    ['GCP', /\b(gcp|google cloud|gke|cloud run|bigquery|pub\/sub|cloud sql|vpc service)\b/g],
    ['DevOps', /\b(devops|kubernetes|k8s|argo|keda|ingress|helm|terraform|docker|ci\/cd|oidc|keycloak|opentelemetry|observability|rollout)\b/g],
    ['FastAPI', /\b(fastapi|pydantic|python|uvicorn|asyncio|dependency injection|lifespan|duckdb|pyarrow|sqlalchemy|postgres)\b/g],
    ['Angular', /\b(angular|rxjs|zoneless|tosignal|toobservable|signal|computed|interceptor|sse)\b/g],
  ];

  for (const [domain, regex] of patterns) {
    const matches = lower.match(regex);
    scores[domain] = matches ? matches.length : 0;
  }

  let best: Domain = 'AWS';
  let bestScore = -1;
  for (const d of VALID_DOMAINS) {
    if (scores[d] > bestScore) {
      best = d;
      bestScore = scores[d];
    }
  }
  return bestScore > 0 ? best : 'DevOps';
}

function normalizeDomain(value: unknown, fallbackText = '', fallbackDomain?: Domain): Domain {
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    const direct = VALID_DOMAINS.find((d) => d.toLowerCase() === cleaned);
    if (direct) return direct;
    if (cleaned.includes('angular') || cleaned.includes('frontend') || cleaned.includes('ui')) {
      return 'Angular';
    }
    if (cleaned.includes('fastapi') || cleaned.includes('python') || cleaned.includes('api') || cleaned.includes('data')) {
      return 'FastAPI';
    }
    if (cleaned.includes('aws') || cleaned.includes('amazon') || cleaned.includes('sqs') || cleaned.includes('eks')) {
      return 'AWS';
    }
    if (cleaned.includes('gcp') || cleaned.includes('google') || cleaned.includes('gke')) {
      return 'GCP';
    }
    if (cleaned.includes('devops') || cleaned.includes('k8s') || cleaned.includes('kubernetes') || cleaned.includes('infra') || cleaned.includes('security')) {
      return 'DevOps';
    }
  }
  return fallbackDomain || inferDomainFromText(fallbackText);
}

function normalizeEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value === 'string') {
    const cleaned = value.trim().toLowerCase();
    const match = allowed.find((item) => item.toLowerCase() === cleaned);
    if (match) return match;
  }
  return fallback;
}

function parseJsonResponse(rawText: string | undefined, context: string): Record<string, unknown> {
  const cleaned = (rawText ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  if (!cleaned) {
    throw new Error(`Empty JSON response received from Gemini for ${context}. Please try again.`);
  }

  const parsed = JSON.parse(cleaned) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).length === 0) {
    throw new Error(`Incomplete JSON payload returned for ${context}. Please try again.`);
  }
  return parsed as Record<string, unknown>;
}

const AI_QUOTA_NOTICE =
  'Gemini API credits are depleted (402). Structured your request using the local curriculum engine so your syllabus and daily quests continue uninterrupted. Top up credits in AI Studio to re-enable full LLM reasoning.';

function isQuotaOrBillingError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const lower = raw.toLowerCase();
  return (
    lower.includes('402') ||
    lower.includes('429') ||
    lower.includes('resource_exhausted') ||
    lower.includes('prepayment credits') ||
    lower.includes('quota') ||
    lower.includes('gemini_api_key is not configured')
  );
}

async function generateWithModelFallback(
  params: Parameters<GoogleGenAI['models']['generateContent']>[0]
) {
  const ai = getAiClient();
  try {
    return await ai.models.generateContent(params);
  } catch (primaryErr) {
    if (params.model !== 'gemini-3.1-flash-lite' && isQuotaOrBillingError(primaryErr)) {
      const { config, ...rest } = params;
      const fallbackConfig = config ? { ...config } : undefined;
      if (fallbackConfig && 'thinkingConfig' in fallbackConfig) {
        delete (fallbackConfig as Record<string, unknown>).thinkingConfig;
      }
      return await ai.models.generateContent({
        ...rest,
        model: 'gemini-3.1-flash-lite',
        config: fallbackConfig,
      });
    }
    throw primaryErr;
  }
}

function rankDomainsFromText(text: string): Domain[] {
  const lower = text.toLowerCase();
  const patterns: Array<[Domain, RegExp]> = [
    ['AWS', /\b(aws|sqs|s3|eks|rds|alb|iam|irsa|cloudfront|cloudwatch|ec2|lambda|ecs)\b/g],
    ['DevOps', /\b(devops|kubernetes|k8s|argo|keda|ingress|helm|terraform|docker|ci\/cd|oidc|keycloak|opentelemetry|observability|rollout|prestop|readinessprobe)\b/g],
    ['FastAPI', /\b(fastapi|pydantic|python|uvicorn|asyncio|dependency injection|lifespan|duckdb|pyarrow|sqlalchemy|postgres|postgresql)\b/g],
    ['Angular', /\b(angular|rxjs|zoneless|tosignal|toobservable|signal|computed|interceptor|sse|pkce)\b/g],
    ['GCP', /\b(gcp|google cloud|gke|cloud run|bigquery|pub\/sub|cloud sql|vpc service)\b/g],
  ];

  return patterns
    .map(([domain, regex]) => ({
      domain,
      count: (lower.match(regex) || []).length,
    }))
    .sort((a, b) => b.count - a.count)
    .filter((entry) => entry.count > 0)
    .map((entry) => entry.domain);
}

interface ParsedBriefSection {
  title: string;
  domain: Domain;
  bullets: string[];
  labs: Array<{ title: string; detail: string }>;
}

function parseProjectBriefSections(rawTaskBrief: string, fallbackDomain: Domain): ParsedBriefSection[] {
  const lines = rawTaskBrief
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const sections: ParsedBriefSection[] = [];
  let current: ParsedBriefSection | null = null;

  for (const line of lines) {
    const sectionMatch = line.match(/^(\d+)[\.\)]\s+(.+)$/);
    if (sectionMatch) {
      if (current) sections.push(current);
      const heading = sectionMatch[2].trim();
      current = {
        title: heading.slice(0, 140),
        domain: inferDomainFromText(heading),
        bullets: [],
        labs: [],
      };
      continue;
    }

    const labMatch = line.match(/^Lab\s+[\d\.]+\s*(?:\(([^)]+)\))?\s*:?\s*(.*)$/i);
    if (labMatch) {
      const labTitle = (labMatch[1] || `Hands-on Lab`).trim();
      const labDetail = (labMatch[2] || line).trim();
      if (!current) {
        current = {
          title: 'Project Core Execution',
          domain: fallbackDomain,
          bullets: [],
          labs: [],
        };
      }
      current.labs.push({ title: labTitle.slice(0, 120), detail: labDetail.slice(0, 500) });
      continue;
    }

    if (!current) {
      current = {
        title: 'Project Core Execution',
        domain: inferDomainFromText(line) || fallbackDomain,
        bullets: [],
        labs: [],
      };
    }
    current.bullets.push(line.replace(/^[-*•]\s*/, ''));
  }

  if (current) sections.push(current);

  for (const s of sections) {
    const combined = `${s.title}\n${s.bullets.join('\n')}\n${s.labs.map((l) => `${l.title}: ${l.detail}`).join('\n')}`;
    const ranked = rankDomainsFromText(combined);
    if (ranked.length > 0) {
      s.domain = ranked[0];
    }
  }

  return sections;
}

function buildStructuredProjectPlanFromBrief(params: {
  projectName?: string;
  rawTaskBrief: string;
  currentSkills: Array<{
    domain: string;
    title: string;
    tier: string;
    priority?: string;
    mastery: number;
  }>;
}) {
  const brief = params.rawTaskBrief.trim();
  const rankedDomains = rankDomainsFromText(brief);
  const primaryDomain: Domain = rankedDomains[0] || 'AWS';
  const involvedDomains: Domain[] = (
    rankedDomains.length > 0 ? rankedDomains : [primaryDomain]
  ).slice(0, 5);

  const sections = parseProjectBriefSections(brief, primaryDomain);
  const inferredTitle =
    asString(params.projectName) ||
    (sections.length > 1
      ? `${sections[0].title.replace(/\([^)]*\)/g, '').trim()} + Multi-Domain Stack`
      : sections[0]?.title) ||
    'Active Cloud Engineering Project';

  const cleanProjectName = inferredTitle.slice(0, 120);

  const masterSyllabusModules = (sections.length > 0 ? sections : [{
    title: `${cleanProjectName} Architecture`,
    domain: primaryDomain,
    bullets: [brief.slice(0, 240)],
    labs: [],
  }])
    .slice(0, 8)
    .map((sec) => {
      const objective = sec.bullets.slice(0, 2).join(' ') || `Deliver ${sec.title} to production Top 1% standards.`;
      const keyInternals =
        sec.bullets.slice(0, 4).join(' • ') ||
        `Failure modes, backpressure, security boundaries, and telemetry in ${sec.domain}.`;
      const verification =
        sec.labs.length > 0
          ? sec.labs.map((l) => `${l.title}: ${l.detail}`).join(' | ')
          : `Verify reliability, IAM/auth boundaries, and observability under load for ${sec.title}.`;

      return {
        title: sec.title.slice(0, 160),
        domain: sec.domain,
        tier: 'Top 1%' as SkillTier,
        objective: objective.slice(0, 400),
        keyInternals: keyInternals.slice(0, 600),
        verificationCriteria: verification.slice(0, 400),
      };
    });

  // Match existing skills with token overlap against the uploaded curriculum
  const briefTokens = new Set(
    brief
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4)
  );
  const existingSkillsToElevate = (params.currentSkills || [])
    .filter((s) => {
      const titleTokens = s.title
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4);
      const overlap = titleTokens.some((t) => briefTokens.has(t));
      return overlap || involvedDomains.includes(normalizeDomain(s.domain, '', primaryDomain));
    })
    .slice(0, 6)
    .map((s) => ({
      existingTitle: s.title,
      priority: (normalizeDomain(s.domain, '', primaryDomain) === primaryDomain
        ? 'Critical'
        : 'High') as SkillPriority,
      reason: `Directly exercised by ${cleanProjectName} across ${s.domain}.`,
    }));

  // Build missing Top 1% skill nodes from extracted labs or top sections
  const existingTitlesLower = new Set((params.currentSkills || []).map((s) => s.title.toLowerCase()));
  const newSkillNodes: Array<{
    domain: Domain;
    title: string;
    tier: SkillTier;
    priority: SkillPriority;
    description: string;
    studyBrief: string;
    labPrompt: string;
  }> = [];

  for (const sec of sections) {
    if (newSkillNodes.length >= 5) break;
    if (sec.labs.length > 0) {
      for (const lab of sec.labs) {
        if (newSkillNodes.length >= 5) break;
        const candidateTitle = `${lab.title} (${sec.domain})`;
        if (existingTitlesLower.has(candidateTitle.toLowerCase())) continue;
        newSkillNodes.push({
          domain: sec.domain,
          title: candidateTitle.slice(0, 160),
          tier: 'Top 1%',
          priority: sec.domain === primaryDomain ? 'Critical' : 'High',
          description: `${sec.title}: ${lab.detail}`.slice(0, 600),
          studyBrief: (
            sec.bullets.join('\n• ') ||
            `Deep engineering patterns and failure modes for ${lab.title}.`
          ).slice(0, 3000),
          labPrompt: `Lab (${lab.title}): ${lab.detail}`.slice(0, 1800),
        });
      }
    } else if (!existingTitlesLower.has(sec.title.toLowerCase())) {
      newSkillNodes.push({
        domain: sec.domain,
        title: sec.title.slice(0, 160),
        tier: 'Top 1%',
        priority: sec.domain === primaryDomain ? 'Critical' : 'High',
        description: (sec.bullets[0] || sec.title).slice(0, 600),
        studyBrief: (sec.bullets.join('\n• ') || sec.title).slice(0, 3000),
        labPrompt: `Implement and verify ${sec.title} with full failure-mode testing and observability.`.slice(
          0,
          1800
        ),
      });
    }
  }

  const weeklyFocusOrder: Domain[] = Array.from(
    new Set([...involvedDomains, ...VALID_DOMAINS])
  ).slice(0, 5);

  const primaryMod = masterSyllabusModules[0];
  const secondaryMod = masterSyllabusModules[1] || primaryMod;
  const tertiaryMod = masterSyllabusModules[2] || primaryMod;

  const dailyQuests = [
    {
      domain: primaryMod.domain,
      questType: 'Project Execution' as QuestType,
      rank: 'A-Rank' as QuestRank,
      title: `Ship Core Module: ${primaryMod.title}`.slice(0, 180),
      objective: primaryMod.objective.slice(0, 1000),
      masteryChecklist: [
        `Review internals: ${primaryMod.keyInternals.slice(0, 180)}`,
        `Implement primary slice for ${cleanProjectName}`,
        `Verify acceptance: ${primaryMod.verificationCriteria.slice(0, 180)}`,
      ],
      linkedSkillTitle: newSkillNodes[0]?.title || primaryMod.title,
      estimatedMinutes: 60,
      xpReward: 120,
    },
    {
      domain: secondaryMod.domain,
      questType: 'Domain Mastery' as QuestType,
      rank: 'A-Rank' as QuestRank,
      title: `Master Internals: ${secondaryMod.title}`.slice(0, 180),
      objective: secondaryMod.objective.slice(0, 1000),
      masteryChecklist: [
        `Map failure modes across ${secondaryMod.domain}`,
        `Verify contract & boundary conditions`,
        `Document Staff-level trade-offs`,
      ],
      linkedSkillTitle: newSkillNodes[1]?.title || secondaryMod.title,
      estimatedMinutes: 45,
      xpReward: 95,
    },
    {
      domain: tertiaryMod.domain,
      questType: 'Production Drill' as QuestType,
      rank: 'S-Rank' as QuestRank,
      title: `Hardening Drill: ${tertiaryMod.title}`.slice(0, 180),
      objective: `Stress-test failure recovery, least-privilege IAM/auth, and zero-downtime behavior in ${tertiaryMod.title}.`,
      masteryChecklist: [
        `Simulate transient failure or retry storm`,
        `Verify telemetry / tracing continuity`,
        `Confirm zero-regression rollout behavior`,
      ],
      linkedSkillTitle: newSkillNodes[2]?.title || tertiaryMod.title,
      estimatedMinutes: 45,
      xpReward: 110,
    },
    {
      domain: primaryDomain,
      questType: 'Active Recall' as QuestType,
      rank: 'B-Rank' as QuestRank,
      title: `${primaryDomain} Failure-Mode Recall Sprint`.slice(0, 180),
      objective: `Test rapid recall on critical architecture invariants across ${involvedDomains.join(', ')}.`,
      masteryChecklist: [
        `Explain root-cause mechanism without notes`,
        `State concrete mitigation and monitoring signal`,
      ],
      linkedSkillTitle: existingSkillsToElevate[0]?.existingTitle || primaryMod.title,
      estimatedMinutes: 25,
      xpReward: 65,
    },
  ];

  const suggestedCards = masterSyllabusModules.slice(0, 2).map((mod) => ({
    domain: mod.domain,
    skillTitle: mod.title,
    prompt: `In ${mod.title}, what production failure mode occurs if key internals (${mod.keyInternals.slice(0, 140)}) are misconfigured?`,
    answer: mod.verificationCriteria,
    explanation: `${mod.objective} (${mod.keyInternals.slice(0, 240)})`,
  }));

  return {
    projectName: cleanProjectName,
    primaryDomain,
    domains: involvedDomains,
    rank: (sections.length >= 4 ? 'S-Rank' : 'A-Rank') as MissionRank,
    masteryGoal: `Deliver ${cleanProjectName} while mastering Top 1% internals across ${involvedDomains.join(', ')}.`.slice(
      0,
      600
    ),
    systemAnnouncement: `${cleanProjectName} activated (${involvedDomains.join(' · ')}). ${masterSyllabusModules.length} syllabus modules & Day 1 quests issued.`,
    weeklyFocusOrder,
    masterSyllabusModules,
    existingSkillsToElevate,
    newSkillNodes,
    dailyQuests,
    suggestedCards,
    aiNotice: AI_QUOTA_NOTICE,
  };
}

function buildStructuredDailyQuests(params: {
  todaySlot: string;
  mode: 'project_override' | 'normal_routine';
  activeProject?: {
    projectName: string;
    primaryDomain: string;
    masteryGoal: string;
    rawTaskBrief: string;
    masterSyllabusModules: Array<{
      title: string;
      domain: string;
      objective: string;
      keyInternals: string;
    }>;
  };
  skills: Array<{
    domain: string;
    title: string;
    tier: string;
    priority: string;
    mastery: number;
    practiceCount: number;
  }>;
}) {
  const focusDomain: Domain = params.activeProject
    ? normalizeDomain(params.activeProject.primaryDomain, params.activeProject.projectName, 'AWS')
    : VALID_DOMAINS.includes(params.todaySlot as Domain)
    ? (params.todaySlot as Domain)
    : (() => {
        const averages = VALID_DOMAINS.map((d) => {
          const subset = (params.skills || []).filter((s) => s.domain === d);
          const avg =
            subset.length > 0
              ? subset.reduce((sum, s) => sum + s.mastery, 0) / subset.length
              : 0;
          return { d, avg };
        }).sort((a, b) => a.avg - b.avg);
        return averages[0]?.d || 'AWS';
      })();

  if (params.mode === 'project_override' && params.activeProject) {
    const mods = params.activeProject.masterSyllabusModules || [];
    const prioritizedSkills = [...(params.skills || [])].sort((a, b) => {
      const aCrit = a.priority === 'Critical' ? 0 : a.priority === 'High' ? 1 : 2;
      const bCrit = b.priority === 'Critical' ? 0 : b.priority === 'High' ? 1 : 2;
      if (aCrit !== bCrit) return aCrit - bCrit;
      return a.mastery - b.mastery;
    });

    const m0 = mods[0] || {
      title: `${params.activeProject.projectName} Core`,
      domain: focusDomain,
      objective: params.activeProject.masteryGoal,
      keyInternals: 'Production internals, security, and observability',
    };
    const m1 = mods[1] || m0;
    const s0 = prioritizedSkills[0];
    const s1 = prioritizedSkills[1] || s0;

    return {
      systemDirective: `Project Override active for ${params.activeProject.projectName} (${focusDomain}). Prioritize shipping project modules to Top 1% standards.`,
      focusDomain,
      dailyQuests: [
        {
          domain: normalizeDomain(m0.domain, m0.title, focusDomain),
          questType: 'Project Execution' as QuestType,
          rank: 'A-Rank' as QuestRank,
          title: `Execute: ${m0.title}`.slice(0, 180),
          objective: (m0.objective || params.activeProject.masteryGoal).slice(0, 1000),
          masteryChecklist: [
            `Review module internals: ${(m0.keyInternals || 'architecture invariants').slice(0, 160)}`,
            `Ship vertical slice for ${params.activeProject.projectName}`,
            'Run verification checks & error-path tests',
          ],
          linkedSkillTitle: s0?.title || m0.title,
          estimatedMinutes: 60,
          xpReward: 120,
        },
        {
          domain: normalizeDomain(m1.domain, m1.title, focusDomain),
          questType: 'Domain Mastery' as QuestType,
          rank: 'A-Rank' as QuestRank,
          title: `Deepen ${m1.domain}: ${m1.title}`.slice(0, 180),
          objective: (m1.objective || `Master Staff-level internals for ${m1.title}.`).slice(0, 1000),
          masteryChecklist: [
            'Trace end-to-end request/event lifecycle',
            'Harden timeouts, retries, and idempotency',
            'Document edge cases learned',
          ],
          linkedSkillTitle: s1?.title || m1.title,
          estimatedMinutes: 45,
          xpReward: 95,
        },
        {
          domain: focusDomain,
          questType: 'Production Drill' as QuestType,
          rank: 'S-Rank' as QuestRank,
          title: `${params.activeProject.projectName}: Reliability & Blast-Radius Audit`.slice(0, 180),
          objective: `Verify failure isolation, least-privilege IAM/auth, and zero-downtime recovery across ${focusDomain}.`,
          masteryChecklist: [
            'Audit failure modes and fallback behavior',
            'Verify metrics/logs catch silent degradation',
          ],
          linkedSkillTitle: s0?.title || focusDomain,
          estimatedMinutes: 40,
          xpReward: 100,
        },
        {
          domain: focusDomain,
          questType: 'Active Recall' as QuestType,
          rank: 'B-Rank' as QuestRank,
          title: `${focusDomain} Active Recall Check`.slice(0, 180),
          objective: `Recall key internals and design trade-offs from ${params.activeProject.projectName} without docs.`,
          masteryChecklist: [
            'Write 3 architecture invariants from memory',
            'Verify against your syllabus brief',
          ],
          linkedSkillTitle: s1?.title || focusDomain,
          estimatedMinutes: 25,
          xpReward: 60,
        },
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // Normal balanced routine: pick lowest-mastery skills in focusDomain
  const domainSkills = (params.skills || [])
    .filter((s) => normalizeDomain(s.domain, '', focusDomain) === focusDomain)
    .sort((a, b) => a.mastery - b.mastery);
  const fallbackSkills = [...(params.skills || [])].sort((a, b) => a.mastery - b.mastery);
  const picks = domainSkills.length > 0 ? domainSkills : fallbackSkills;

  const sk0 = picks[0] || { domain: focusDomain, title: `${focusDomain} Core Internals`, tier: 'Senior', mastery: 30 };
  const sk1 = picks[1] || sk0;
  const sk2 = picks[2] || sk0;

  return {
    systemDirective: `Normal Routine (${params.todaySlot}): Targeting lowest-mastery ${focusDomain} nodes to raise your Top 1% baseline.`,
    focusDomain,
    dailyQuests: [
      {
        domain: focusDomain,
        questType: 'Domain Mastery' as QuestType,
        rank: 'A-Rank' as QuestRank,
        title: `Master ${sk0.title}`.slice(0, 180),
        objective: `Close gaps in ${sk0.title} (${sk0.tier}, current ${sk0.mastery}% mastery) with hands-on internals practice.`,
        masteryChecklist: [
          `Review core runtime mechanics of ${sk0.title}`,
          'Implement or inspect production config/code',
          'Validate edge cases and failure modes',
        ],
        linkedSkillTitle: sk0.title,
        estimatedMinutes: 45,
        xpReward: 95,
      },
      {
        domain: focusDomain,
        questType: 'Production Drill' as QuestType,
        rank: 'A-Rank' as QuestRank,
        title: `Production Failure Drill: ${sk1.title}`.slice(0, 180),
        objective: `Diagnose and harden a realistic outage or scaling bottleneck involving ${sk1.title}.`,
        masteryChecklist: [
          'Identify root cause & blast radius',
          'Apply least-privilege / resilience mitigation',
          'Define alert/SLO verification',
        ],
        linkedSkillTitle: sk1.title,
        estimatedMinutes: 45,
        xpReward: 100,
      },
      {
        domain: focusDomain,
        questType: 'Project Execution' as QuestType,
        rank: 'B-Rank' as QuestRank,
        title: `Hands-On Lab: ${sk2.title}`.slice(0, 180),
        objective: `Complete a 40-minute focused lab applying ${sk2.title} with verifiable output.`,
        masteryChecklist: [
          'Build working prototype or script',
          'Confirm clean behavior under retries/load',
        ],
        linkedSkillTitle: sk2.title,
        estimatedMinutes: 40,
        xpReward: 80,
      },
      {
        domain: focusDomain,
        questType: 'Active Recall' as QuestType,
        rank: 'B-Rank' as QuestRank,
        title: `${focusDomain} Architecture Recall`.slice(0, 180),
        objective: `Synthesize top trade-offs and security boundaries across ${sk0.title} and ${sk1.title}.`,
        masteryChecklist: [
          'Summarize 3 production pitfalls from memory',
          'Cross-check with your syllabus study brief',
        ],
        linkedSkillTitle: sk0.title,
        estimatedMinutes: 20,
        xpReward: 55,
      },
    ],
    aiNotice: AI_QUOTA_NOTICE,
  };
}

function buildStructuredStudyBrief(params: {
  domain: string;
  title: string;
  tier: string;
  description: string;
}) {
  return {
    studyBrief: [
      `Core Internals — ${params.title} (${params.domain} · ${params.tier})`,
      params.description || `Production architecture and failure-mode mastery for ${params.title}.`,
      '',
      'Top 1% Engineering Checklist:',
      '• Know the exact execution/concurrency lifecycle and where backpressure or lock contention happens.',
      '• Enforce strict failure isolation (bounded retries with jitter, explicit timeouts, idempotency keys, and least-privilege IAM/auth boundaries).',
      '• Instrument Golden Signals (latency quantiles, error budget burn, saturation metrics) so silent degradation surfaces immediately.',
    ].join('\n'),
    labPrompt: `45-Minute Lab (${params.title}): Implement a minimal reproducible setup in ${params.domain}, inject a transient fault (timeout, 503, permission boundary conflict, or duplicate delivery), verify automated recovery/observability, and document your verification criteria.`,
    aiNotice: AI_QUOTA_NOTICE,
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/ai/map-work-log', async (req, res) => {
  const { projectName, taskSummary, minutesSpent, currentSkills } = (req.body || {}) as {
    projectName: string;
    taskSummary: string;
    minutesSpent: number;
    currentSkills: Array<{ id: string; domain: string; title: string; mastery: number }>;
  };

  if (!projectName?.trim() || !taskSummary?.trim()) {
    res.status(400).json({ error: 'Project name and task summary are required.' });
    return;
  }

  try {
    const skillCatalogText = (currentSkills || [])
      .map((s) => `[${s.domain}] ${s.title} (${s.mastery}%)`)
      .join('\n');

    const response = await generateWithModelFallback({
      model: 'gemini-4-hydrogen',
      contents: `Analyze this Associate Cloud Engineer's real work log and map it to their 5-domain Top 1% mastery system (Angular, FastAPI, DevOps, AWS, GCP).

Project: ${projectName}
Time Spent: ${minutesSpent || 45} minutes
Work Summary:
${taskSummary}

Existing Skill Matrix Nodes:
${skillCatalogText}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        systemInstruction:
          'You are a Principal Cloud & Full-Stack Engineering Mentor coaching an Associate Cloud Engineer toward Top 1% mastery in Angular, FastAPI, DevOps, AWS, and GCP. Be concrete, technical, and incisive. Identify which domains and existing skill titles were exercised, calculate fair XP (10 to 80 based on depth/complexity), write a sharp "elevationNote" describing what a Staff/Top 1% engineer would harden, measure, or verify next in this exact task, and create one practical spaced-repetition card capturing the deepest lesson.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            primaryDomain: {
              type: Type.STRING,
              enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
            },
            domains: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING,
                enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
              },
            },
            extractedSkills: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: '3 to 6 concise technical skills demonstrated in this work.',
            },
            matchedSkillTitles: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: 'Exact titles from the provided Existing Skill Matrix Nodes that align best.',
            },
            xpAwarded: {
              type: Type.INTEGER,
              description: 'XP awarded between 10 and 80.',
            },
            elevationNote: {
              type: Type.STRING,
              description:
                'Concrete Staff-level engineering feedback: what edge cases, observability, security boundaries, or architectural improvements elevate this work to Top 1% quality.',
            },
            suggestedFlashcard: {
              type: Type.OBJECT,
              properties: {
                domain: {
                  type: Type.STRING,
                  enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                },
                skillTitle: { type: Type.STRING },
                prompt: { type: Type.STRING },
                answer: { type: Type.STRING },
                explanation: { type: Type.STRING },
              },
              required: ['domain', 'skillTitle', 'prompt', 'answer', 'explanation'],
            },
          },
          required: [
            'primaryDomain',
            'domains',
            'extractedSkills',
            'matchedSkillTitles',
            'xpAwarded',
            'elevationNote',
            'suggestedFlashcard',
          ],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (error) {
    if (isQuotaOrBillingError(error)) {
      const combined = `${projectName}\n${taskSummary}`;
      const rankedDomains = rankDomainsFromText(combined);
      const primaryDomain: Domain = rankedDomains[0] || inferDomainFromText(combined);
      const domains = (rankedDomains.length > 0 ? rankedDomains : [primaryDomain]).slice(0, 5);
      const tokens = combined
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length >= 4);
      const matched = (currentSkills || [])
        .filter(
          (s) =>
            normalizeDomain(s.domain, s.title, primaryDomain) === primaryDomain ||
            tokens.some((tok) => s.title.toLowerCase().includes(tok))
        )
        .slice(0, 3)
        .map((s) => s.title);

      res.json({
        primaryDomain,
        domains,
        extractedSkills: matched.length > 0 ? matched : [`${primaryDomain} Production Execution`],
        matchedSkillTitles: matched,
        xpAwarded: Math.min(80, Math.max(30, Math.round((minutesSpent || 45) * 0.9))),
        elevationNote: `Completed "${projectName}" across ${domains.join(', ')}. To lock in Top 1% rigor, document failure modes, idempotency invariants, and SLO verification for this deliverable.`,
        suggestedFlashcard: {
          domain: primaryDomain,
          skillTitle: matched[0] || `${primaryDomain} Architecture`,
          prompt: `In "${projectName}", what primary reliability or security boundary protects ${primaryDomain} under load?`,
          answer: 'Enforce bounded retries with jitter, explicit timeouts, least-privilege IAM/auth checks, and idempotency.',
          explanation: `Captured from completed task: ${taskSummary.slice(0, 220)}`,
        },
      });
      return;
    }
    handleAiError(res, error, 'map-work-log');
  }
});

app.post('/api/ai/analyze-gaps', async (req, res) => {
  try {
    const { skills, recentWorkLogs, weeklyHoursTarget } = req.body as {
      skills: Array<{
        domain: string;
        title: string;
        tier: string;
        priority?: string;
        projectTag?: string;
        mastery: number;
      }>;
      recentWorkLogs: Array<{ projectName: string; primaryDomain: string; taskSummary: string }>;
      weeklyHoursTarget: number;
    };

    const ai = getAiClient();
    const skillSummary = (skills || [])
      .map(
        (s) =>
          `${s.domain} | ${s.tier} | Priority: ${s.priority || 'Normal'}${
            s.projectTag ? ` (${s.projectTag})` : ''
          } | ${s.title}: ${s.mastery}%`
      )
      .join('\n');
    const logSummary = (recentWorkLogs || [])
      .slice(0, 10)
      .map((l) => `- [${l.primaryDomain}] ${l.projectName}: ${l.taskSummary.slice(0, 180)}`)
      .join('\n');

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Perform a Top 1% Skill Gap Audit across Angular, FastAPI, DevOps, AWS, and GCP.
Weekly Upskilling Budget: ${weeklyHoursTarget || 10} hours/week.

Current Skill Matrix (pay special attention to Critical/High active project priorities):
${skillSummary}

Recent Work Logs:
${logSummary || 'No recent work logs recorded yet.'}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        systemInstruction:
          'You are a Principal Engineer running a rigorous Top 1% readiness audit. Prioritize active project topics marked Critical or High alongside foundational blind spots across Angular, FastAPI, DevOps, AWS, and GCP. Recommend concrete, production-realistic actions and up to 3 new Top 1% or Senior skill nodes if missing.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            executiveSummary: {
              type: Type.STRING,
              description:
                '2-3 sentences diagnosing overall balance, active project priority alignment, and biggest bottleneck toward Top 1%.',
            },
            priorityGaps: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  title: { type: Type.STRING },
                  tier: {
                    type: Type.STRING,
                    enum: ['Foundational', 'Senior', 'Top 1%'],
                  },
                  whyItMatters: { type: Type.STRING },
                  concreteAction: { type: Type.STRING },
                },
                required: ['domain', 'title', 'tier', 'whyItMatters', 'concreteAction'],
              },
            },
            recommendedSkillsToAdd: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  title: { type: Type.STRING },
                  tier: {
                    type: Type.STRING,
                    enum: ['Foundational', 'Senior', 'Top 1%'],
                  },
                  description: { type: Type.STRING },
                  labPrompt: { type: Type.STRING },
                },
                required: ['domain', 'title', 'tier', 'description', 'labPrompt'],
              },
            },
          },
          required: ['executiveSummary', 'priorityGaps', 'recommendedSkillsToAdd'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (error) {
    handleAiError(res, error, 'analyze-gaps');
  }
});

app.post('/api/ai/adapt-syllabus', async (req, res) => {
  try {
    const { projectTag, defaultPriority, rawTopicsText, currentSkills } = req.body as {
      projectTag?: string;
      defaultPriority?: 'Critical' | 'High' | 'Normal';
      rawTopicsText: string;
      currentSkills: Array<{
        domain: string;
        title: string;
        tier: string;
        priority?: string;
        mastery: number;
      }>;
    };

    if (!rawTopicsText?.trim()) {
      res.status(400).json({ error: 'Please enter at least one project topic to adapt.' });
      return;
    }

    const ai = getAiClient();
    const existingList = (currentSkills || [])
      .map(
        (s) =>
          `[${s.domain} | ${s.tier} | Priority: ${s.priority || 'Normal'} | ${s.mastery}%] ${s.title}`
      )
      .join('\n');

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `The Associate Cloud Engineer needs to adapt their Top 1% learning syllabus for active project work.

Active Project Tag: ${projectTag?.trim() || 'Active Work Project'}
Requested Priority Level: ${defaultPriority || 'Critical'}
User's Topics / Project Requirements:
${rawTopicsText.trim()}

Existing Skill Matrix Nodes:
${existingList}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        systemInstruction:
          'You are a Principal Cloud & Full-Stack Engineering Mentor. Parse every topic the engineer provided. If a topic maps cleanly to an Existing Skill Matrix Node, list it under prioritizeExistingTitles (using the exact existing title) rather than duplicating it. For every new topic not yet in the matrix, create a crisp Staff-calibrated node in newTopics with its domain (Angular, FastAPI, DevOps, AWS, or GCP), appropriate tier (Foundational, Senior, Top 1%), priority (respecting the requested priority unless clearly lower), a sharp studyBrief covering internals/failure modes, and a concrete 45-min labPrompt. Also output recommendedWeeklyFocusOrder containing all 5 domains (Angular, FastAPI, DevOps, AWS, GCP) ordered so the most urgent project domains come earliest in the Mon-Fri rotation, plus 2-3 targeted spaced-repetition cards in suggestedCards.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            adaptationSummary: {
              type: Type.STRING,
              description:
                '2-3 sentences summarizing how the syllabus and weekly rotation were adapted for these project topics.',
            },
            recommendedWeeklyFocusOrder: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING,
                enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
              },
              description: 'All 5 unique domains ordered from highest urgency (Mon) to lowest (Fri).',
            },
            newTopics: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  title: { type: Type.STRING },
                  tier: {
                    type: Type.STRING,
                    enum: ['Foundational', 'Senior', 'Top 1%'],
                  },
                  priority: {
                    type: Type.STRING,
                    enum: ['Critical', 'High', 'Normal'],
                  },
                  description: { type: Type.STRING },
                  studyBrief: { type: Type.STRING },
                  labPrompt: { type: Type.STRING },
                },
                required: [
                  'domain',
                  'title',
                  'tier',
                  'priority',
                  'description',
                  'studyBrief',
                  'labPrompt',
                ],
              },
            },
            prioritizeExistingTitles: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  existingTitle: { type: Type.STRING },
                  priority: {
                    type: Type.STRING,
                    enum: ['Critical', 'High', 'Normal'],
                  },
                  reason: { type: Type.STRING },
                },
                required: ['existingTitle', 'priority', 'reason'],
              },
            },
            suggestedCards: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  skillTitle: { type: Type.STRING },
                  prompt: { type: Type.STRING },
                  answer: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                },
                required: ['domain', 'skillTitle', 'prompt', 'answer', 'explanation'],
              },
            },
          },
          required: [
            'adaptationSummary',
            'recommendedWeeklyFocusOrder',
            'newTopics',
            'prioritizeExistingTitles',
            'suggestedCards',
          ],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (error) {
    handleAiError(res, error, 'adapt-syllabus');
  }
});

app.post('/api/ai/syllabus-agent', async (req, res) => {
  try {
    const {
      userMessage,
      projectContext,
      conversationHistory,
      progressSnapshot,
    } = req.body as {
      userMessage: string;
      projectContext?: string;
      conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
      progressSnapshot: {
        weeklyHoursTarget: number;
        streakDays: number;
        rotationMap: Record<string, string>;
        domainFocusMinutes: Record<string, number>;
        dueCardsCount: number;
        skills: Array<{
          domain: string;
          title: string;
          tier: string;
          priority: string;
          projectTag: string;
          mastery: number;
          practiceCount: number;
        }>;
        recentWorkLogs: Array<{
          projectName: string;
          primaryDomain: string;
          taskSummary: string;
          minutesSpent: number;
        }>;
      };
    };

    if (!userMessage?.trim()) {
      res.status(400).json({ error: 'Message is required.' });
      return;
    }

    const ai = getAiClient();
    const skillsText = (progressSnapshot?.skills || [])
      .map(
        (s) =>
          `- [${s.domain} | ${s.tier} | Priority: ${s.priority} | Mastery: ${s.mastery}% | Reps: ${s.practiceCount}${
            s.projectTag ? ` | Project: ${s.projectTag}` : ''
          }] ${s.title}`
      )
      .join('\n');

    const logsText = (progressSnapshot?.recentWorkLogs || [])
      .slice(0, 8)
      .map(
        (l) =>
          `- [${l.primaryDomain} · ${l.minutesSpent}m] ${l.projectName}: ${l.taskSummary.slice(0, 180)}`
      )
      .join('\n');

    const historyText = (conversationHistory || [])
      .slice(-8)
      .map((m) => `${m.role === 'user' ? 'Engineer' : 'Syllabus Agent'}: ${m.content}`)
      .join('\n\n');

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Engineer Progress Snapshot:
- Weekly Budget: ${progressSnapshot?.weeklyHoursTarget || 10} hrs/week | Streak: ${
        progressSnapshot?.streakDays || 0
      } days | Due SM-2 Cards: ${progressSnapshot?.dueCardsCount || 0}
- Current Weekly Rotation: ${JSON.stringify(progressSnapshot?.rotationMap || {})}
- Focus Minutes This Week: ${JSON.stringify(progressSnapshot?.domainFocusMinutes || {})}
- Active Project Context: ${projectContext?.trim() || 'Not specified yet'}

Current Syllabus & Mastery Matrix:
${skillsText || 'No skills loaded.'}

Recent Project Work Logs:
${logsText || 'None yet.'}

Recent Conversation:
${historyText || '(New session)'}

Engineer's Request:
${userMessage.trim()}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
        systemInstruction:
          'You are an autonomous, Staff-level Learning Progress & Syllabus Architect Agent for an Associate Cloud Engineer striving for Top 1% mastery across Angular, FastAPI, DevOps, AWS, and GCP. Analyze their actual mastery metrics, focus minutes, and project requirements. If they share new project requirements, ask to structure/adapt/update their syllabus, or when their progress warrants restructuring (e.g., promoting lagging domains, deepening mastered nodes, pruning obsolete priorities), set shouldProposeUpdate=true and emit a concrete, structured SyllabusProposal that maps cleanly to their 5 domains. Only reference existing titles verbatim when placing them in updateTopics or removeOrDemoteTitles. Keep weeklyFocusOrder as all 5 unique domains (Angular, FastAPI, DevOps, AWS, GCP) ordered from highest urgency Mon to Fri. If the user is only asking a general conceptual question without wanting syllabus changes, set shouldProposeUpdate=false.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            sessionTitle: {
              type: Type.STRING,
              description: 'Concise 3-6 word title summarizing this thread.',
            },
            assistantReply: {
              type: Type.STRING,
              description:
                'Direct, analytical response citing the engineer’s actual mastery/progress numbers and explaining your structuring rationale.',
            },
            shouldProposeUpdate: {
              type: Type.BOOLEAN,
              description:
                'True whenever the syllabus, topic priorities, or weekly rotation should be updated in Firestore.',
            },
            proposal: {
              type: Type.OBJECT,
              properties: {
                summary: { type: Type.STRING },
                projectTag: { type: Type.STRING },
                weeklyFocusOrder: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                },
                addTopics: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      domain: {
                        type: Type.STRING,
                        enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                      },
                      title: { type: Type.STRING },
                      tier: {
                        type: Type.STRING,
                        enum: ['Foundational', 'Senior', 'Top 1%'],
                      },
                      priority: {
                        type: Type.STRING,
                        enum: ['Critical', 'High', 'Normal'],
                      },
                      description: { type: Type.STRING },
                      studyBrief: { type: Type.STRING },
                      labPrompt: { type: Type.STRING },
                    },
                    required: [
                      'domain',
                      'title',
                      'tier',
                      'priority',
                      'description',
                      'studyBrief',
                      'labPrompt',
                    ],
                  },
                },
                updateTopics: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      existingTitle: { type: Type.STRING },
                      tier: {
                        type: Type.STRING,
                        enum: ['Foundational', 'Senior', 'Top 1%'],
                      },
                      priority: {
                        type: Type.STRING,
                        enum: ['Critical', 'High', 'Normal'],
                      },
                      projectTag: { type: Type.STRING },
                      reason: { type: Type.STRING },
                      updatedStudyBrief: { type: Type.STRING },
                      updatedLabPrompt: { type: Type.STRING },
                    },
                    required: ['existingTitle', 'tier', 'priority', 'projectTag', 'reason'],
                  },
                },
                removeOrDemoteTitles: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      existingTitle: { type: Type.STRING },
                      action: {
                        type: Type.STRING,
                        enum: ['demote', 'remove'],
                      },
                      reason: { type: Type.STRING },
                    },
                    required: ['existingTitle', 'action', 'reason'],
                  },
                },
                newReviewCards: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      domain: {
                        type: Type.STRING,
                        enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                      },
                      skillTitle: { type: Type.STRING },
                      prompt: { type: Type.STRING },
                      answer: { type: Type.STRING },
                      explanation: { type: Type.STRING },
                    },
                    required: ['domain', 'skillTitle', 'prompt', 'answer', 'explanation'],
                  },
                },
              },
              required: [
                'summary',
                'projectTag',
                'weeklyFocusOrder',
                'addTopics',
                'updateTopics',
                'removeOrDemoteTitles',
                'newReviewCards',
              ],
            },
          },
          required: ['sessionTitle', 'assistantReply', 'shouldProposeUpdate', 'proposal'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (error) {
    handleAiError(res, error, 'syllabus-agent');
  }
});

app.post('/api/ai/system-upload-project', async (req, res) => {
  const { projectName, rawTaskBrief, currentSkills, weeklyHoursTarget } = (req.body || {}) as {
    projectName?: string;
    rawTaskBrief: string;
    weeklyHoursTarget?: number;
    currentSkills: Array<{
      domain: string;
      title: string;
      tier: string;
      priority?: string;
      mastery: number;
    }>;
  };

  if (!rawTaskBrief?.trim()) {
    res.status(400).json({ error: 'Project task specification or uploaded brief is required.' });
    return;
  }

  try {
    const existingList = (currentSkills || [])
      .map(
        (s) =>
          `[${s.domain} | ${s.tier} | Priority: ${s.priority || 'Normal'} | ${s.mastery}%] ${s.title}`
      )
      .join('\n');

    const clippedBrief = rawTaskBrief.trim().slice(0, 8000);
    const response = await generateWithModelFallback({
      model: 'gemini-4-hydrogen',
      contents: `An Associate Cloud Engineer just uploaded a real project task and wants "The System" to automatically take over syllabus planning, prioritize this project above normal rotation, make them excel to Top 1% mastery in the project's domain, and issue Day 1's Daily Quests.

Optional Project Name: ${projectName?.trim() || 'Infer concise project name from brief'}
Weekly Hours Budget: ${weeklyHoursTarget || 10} hrs/week

Uploaded Project Task / Brief:
${clippedBrief}

Existing Skill Matrix Nodes:
${existingList}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        systemInstruction:
          'You are "The System" — a Principal Engineering Progression Engine. Zero manual toil for the engineer. Analyze the uploaded project task (even if multi-domain, pick the single highest-leverage primaryDomain from Angular, FastAPI, DevOps, AWS, or GCP): (1) populate projectName, primaryDomain, domains (1-5), rank (C-Rank to S-Rank), masteryGoal, systemAnnouncement, and weeklyFocusOrder (all 5 domains starting with primaryDomain); (2) produce 3-5 concise masterSyllabusModules; (3) map matching Existing Skill Matrix Nodes verbatim in existingSkillsToElevate, and synthesize 2-3 missing Top 1%/Senior nodes in newSkillNodes with concise studyBrief (500-900 chars) and 45-min labPrompt; (4) issue 4 concrete dailyQuests for today (1 Project Execution, 1 Domain Mastery, 1 Production Drill, 1 Active Recall) with 3 crisp checklist steps each, realistic minutes (15-90), and XP rewards (25-150); (5) include 2 targeted SM-2 review cards. Every required JSON field must be populated.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            projectName: { type: Type.STRING },
            primaryDomain: {
              type: Type.STRING,
              enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
            },
            domains: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING,
                enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
              },
            },
            rank: {
              type: Type.STRING,
              enum: ['C-Rank', 'B-Rank', 'A-Rank', 'S-Rank'],
            },
            masteryGoal: { type: Type.STRING },
            systemAnnouncement: { type: Type.STRING },
            weeklyFocusOrder: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING,
                enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
              },
            },
            masterSyllabusModules: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  title: { type: Type.STRING },
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  tier: {
                    type: Type.STRING,
                    enum: ['Foundational', 'Senior', 'Top 1%'],
                  },
                  objective: { type: Type.STRING },
                  keyInternals: { type: Type.STRING },
                  verificationCriteria: { type: Type.STRING },
                },
                required: [
                  'title',
                  'domain',
                  'tier',
                  'objective',
                  'keyInternals',
                  'verificationCriteria',
                ],
              },
            },
            existingSkillsToElevate: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  existingTitle: { type: Type.STRING },
                  priority: {
                    type: Type.STRING,
                    enum: ['Critical', 'High', 'Normal'],
                  },
                  reason: { type: Type.STRING },
                },
                required: ['existingTitle', 'priority', 'reason'],
              },
            },
            newSkillNodes: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  title: { type: Type.STRING },
                  tier: {
                    type: Type.STRING,
                    enum: ['Foundational', 'Senior', 'Top 1%'],
                  },
                  priority: {
                    type: Type.STRING,
                    enum: ['Critical', 'High', 'Normal'],
                  },
                  description: { type: Type.STRING },
                  studyBrief: { type: Type.STRING },
                  labPrompt: { type: Type.STRING },
                },
                required: [
                  'domain',
                  'title',
                  'tier',
                  'priority',
                  'description',
                  'studyBrief',
                  'labPrompt',
                ],
              },
            },
            dailyQuests: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  questType: {
                    type: Type.STRING,
                    enum: [
                      'Project Execution',
                      'Domain Mastery',
                      'Production Drill',
                      'Active Recall',
                    ],
                  },
                  rank: {
                    type: Type.STRING,
                    enum: ['E-Rank', 'D-Rank', 'C-Rank', 'B-Rank', 'A-Rank', 'S-Rank'],
                  },
                  title: { type: Type.STRING },
                  objective: { type: Type.STRING },
                  masteryChecklist: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  linkedSkillTitle: { type: Type.STRING },
                  estimatedMinutes: { type: Type.INTEGER },
                  xpReward: { type: Type.INTEGER },
                },
                required: [
                  'domain',
                  'questType',
                  'rank',
                  'title',
                  'objective',
                  'masteryChecklist',
                  'linkedSkillTitle',
                  'estimatedMinutes',
                  'xpReward',
                ],
              },
            },
            suggestedCards: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  skillTitle: { type: Type.STRING },
                  prompt: { type: Type.STRING },
                  answer: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                },
                required: ['domain', 'skillTitle', 'prompt', 'answer', 'explanation'],
              },
            },
          },
          required: [
            'projectName',
            'primaryDomain',
            'domains',
            'rank',
            'masteryGoal',
            'systemAnnouncement',
            'weeklyFocusOrder',
            'masterSyllabusModules',
            'existingSkillsToElevate',
            'newSkillNodes',
            'dailyQuests',
            'suggestedCards',
          ],
        },
      },
    });

    const parsed = parseJsonResponse(response.text, 'system-upload-project');

    const resolvedProjectName = asString(
      parsed.projectName,
      asString(projectName, 'Active Project Mission')
    ).slice(0, 120);

    const inferredPrimary = inferDomainFromText(`${resolvedProjectName}\n${clippedBrief}`);
    const resolvedPrimaryDomain = normalizeDomain(
      parsed.primaryDomain,
      `${resolvedProjectName}\n${clippedBrief}`,
      inferredPrimary
    );

    const rawDomains = Array.isArray(parsed.domains) ? parsed.domains : [];
    const normalizedDomains = Array.from(
      new Set([
        resolvedPrimaryDomain,
        ...rawDomains.map((d) => normalizeDomain(d, clippedBrief, resolvedPrimaryDomain)),
      ])
    ).slice(0, 5);

    const rawWeekly = Array.isArray(parsed.weeklyFocusOrder) ? parsed.weeklyFocusOrder : [];
    const normalizedWeekly = Array.from(
      new Set([
        resolvedPrimaryDomain,
        ...rawWeekly.map((d) => normalizeDomain(d, clippedBrief, resolvedPrimaryDomain)),
        ...VALID_DOMAINS,
      ])
    ).slice(0, 5);

    const rawModules = Array.isArray(parsed.masterSyllabusModules) ? parsed.masterSyllabusModules : [];
    const masterSyllabusModules = rawModules
      .filter((m): m is Record<string, unknown> => Boolean(m && typeof m === 'object'))
      .slice(0, 8)
      .map((m, idx) => ({
        title: asString(m.title, `Module ${idx + 1}: ${resolvedProjectName} Core`),
        domain: normalizeDomain(m.domain, `${asString(m.title)} ${asString(m.objective)}`, resolvedPrimaryDomain),
        tier: normalizeEnum(m.tier, VALID_TIERS, 'Top 1%'),
        objective: asString(m.objective, `Deliver production-grade execution for ${resolvedProjectName}.`),
        keyInternals: asString(m.keyInternals, 'Failure modes, backpressure, security boundaries, and telemetry.'),
        verificationCriteria: asString(m.verificationCriteria, 'Verified under load with clean observability and tests.'),
      }));

    if (masterSyllabusModules.length === 0) {
      masterSyllabusModules.push({
        title: `${resolvedProjectName} Architecture & Internals`,
        domain: resolvedPrimaryDomain,
        tier: 'Top 1%',
        objective: `Execute ${resolvedProjectName} cleanly while mastering Top 1% ${resolvedPrimaryDomain} internals.`,
        keyInternals: 'Production reliability, security least privilege, and failure recovery.',
        verificationCriteria: 'End-to-end verification and zero-regression checks pass.',
      });
    }

    const rawElevate = Array.isArray(parsed.existingSkillsToElevate)
      ? parsed.existingSkillsToElevate
      : [];
    const existingSkillsToElevate = rawElevate
      .filter((e): e is Record<string, unknown> => Boolean(e && typeof e === 'object'))
      .map((e) => ({
        existingTitle: asString(e.existingTitle),
        priority: normalizeEnum(e.priority, VALID_PRIORITIES, 'High'),
        reason: asString(e.reason, `Core competency needed for ${resolvedProjectName}.`),
      }))
      .filter((e) => e.existingTitle.length > 0);

    const rawNodes = Array.isArray(parsed.newSkillNodes) ? parsed.newSkillNodes : [];
    const newSkillNodes = rawNodes
      .filter((n): n is Record<string, unknown> => Boolean(n && typeof n === 'object'))
      .slice(0, 6)
      .map((n) => ({
        domain: normalizeDomain(n.domain, `${asString(n.title)} ${asString(n.description)}`, resolvedPrimaryDomain),
        title: asString(n.title),
        tier: normalizeEnum(n.tier, VALID_TIERS, 'Top 1%'),
        priority: normalizeEnum(n.priority, VALID_PRIORITIES, 'Critical'),
        description: asString(n.description, `Mastery node synthesized from ${resolvedProjectName}.`),
        studyBrief: asString(
          n.studyBrief,
          `Focus on internals, failure modes, and verifiable production telemetry for ${resolvedProjectName}.`
        ),
        labPrompt: asString(
          n.labPrompt,
          `Build and verify a production-grade implementation for ${resolvedProjectName}.`
        ),
      }))
      .filter((n) => n.title.length > 0);

    const rawQuests = Array.isArray(parsed.dailyQuests) ? parsed.dailyQuests : [];
    const dailyQuests = rawQuests
      .filter((q): q is Record<string, unknown> => Boolean(q && typeof q === 'object'))
      .slice(0, 5)
      .map((q, idx) => {
        const checklist = Array.isArray(q.masteryChecklist)
          ? q.masteryChecklist.map((c) => asString(c)).filter(Boolean).slice(0, 6)
          : [];
        return {
          domain: normalizeDomain(q.domain, `${asString(q.title)} ${asString(q.objective)}`, resolvedPrimaryDomain),
          questType: normalizeEnum(
            q.questType,
            VALID_QUEST_TYPES,
            VALID_QUEST_TYPES[idx % VALID_QUEST_TYPES.length]
          ),
          rank: normalizeEnum(q.rank, VALID_QUEST_RANKS, 'B-Rank'),
          title: asString(q.title, `${resolvedProjectName} Quest ${idx + 1}`),
          objective: asString(q.objective, `Complete core ${resolvedPrimaryDomain} execution for ${resolvedProjectName}.`),
          masteryChecklist:
            checklist.length > 0
              ? checklist
              : [
                  'Implement core module cleanly',
                  'Verify failure modes and edge cases',
                  'Document telemetry or verification check',
                ],
          linkedSkillTitle: asString(q.linkedSkillTitle, masterSyllabusModules[0].title),
          estimatedMinutes: Math.min(
            240,
            Math.max(5, Math.round(Number(q.estimatedMinutes) || 45))
          ),
          xpReward: Math.min(300, Math.max(10, Math.round(Number(q.xpReward) || 75))),
        };
      });

    if (dailyQuests.length === 0) {
      dailyQuests.push({
        domain: resolvedPrimaryDomain,
        questType: 'Project Execution',
        rank: 'A-Rank',
        title: `Kick off ${resolvedProjectName} (${resolvedPrimaryDomain})`,
        objective: `Execute the primary architecture and reliability checks for ${resolvedProjectName}.`,
        masteryChecklist: [
          'Review project requirements and failure boundaries',
          'Implement first vertical slice with tests',
          'Verify observability and error handling',
        ],
        linkedSkillTitle: masterSyllabusModules[0].title,
        estimatedMinutes: 45,
        xpReward: 90,
      });
    }

    const rawCards = Array.isArray(parsed.suggestedCards) ? parsed.suggestedCards : [];
    const suggestedCards = rawCards
      .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
      .slice(0, 4)
      .map((c) => ({
        domain: normalizeDomain(c.domain, `${asString(c.skillTitle)} ${asString(c.prompt)}`, resolvedPrimaryDomain),
        skillTitle: asString(c.skillTitle, masterSyllabusModules[0].title),
        prompt: asString(c.prompt),
        answer: asString(c.answer),
        explanation: asString(c.explanation, 'Key architectural invariant for Top 1% mastery.'),
      }))
      .filter((c) => c.prompt.length > 0 && c.answer.length > 0);

    res.json({
      projectName: resolvedProjectName,
      primaryDomain: resolvedPrimaryDomain,
      domains: normalizedDomains,
      rank: normalizeEnum(parsed.rank, VALID_MISSION_RANKS, 'A-Rank'),
      masteryGoal: asString(
        parsed.masteryGoal,
        `Ship ${resolvedProjectName} cleanly while achieving Top 1% mastery across ${normalizedDomains.join(', ')}.`
      ),
      systemAnnouncement: asString(
        parsed.systemAnnouncement,
        `${resolvedProjectName} activated. Master syllabus updated and Day 1 quests issued.`
      ),
      weeklyFocusOrder: normalizedWeekly,
      masterSyllabusModules,
      existingSkillsToElevate,
      newSkillNodes,
      dailyQuests,
      suggestedCards,
    });
  } catch (error) {
    if (isQuotaOrBillingError(error)) {
      console.warn('[system-upload-project] Gemini quota/credits unavailable; using local curriculum parser.');
      res.json(
        buildStructuredProjectPlanFromBrief({
          projectName,
          rawTaskBrief,
          currentSkills: currentSkills || [],
        })
      );
      return;
    }
    handleAiError(res, error, 'system-upload-project');
  }
});

app.post('/api/ai/system-daily-quests', async (req, res) => {
  const {
    dateKey,
    todaySlot,
    mode,
    activeProject,
    skills,
    recentWorkLogs,
    domainFocusMinutes,
    dueCardsCount,
    weeklyHoursTarget,
  } = (req.body || {}) as {
    dateKey: string;
    todaySlot: string;
    mode: 'project_override' | 'normal_routine';
    activeProject?: {
      projectName: string;
      primaryDomain: string;
      masteryGoal: string;
      rawTaskBrief: string;
      masterSyllabusModules: Array<{
        title: string;
        domain: string;
        objective: string;
        keyInternals: string;
      }>;
    };
    skills: Array<{
      domain: string;
      title: string;
      tier: string;
      priority: string;
      mastery: number;
      practiceCount: number;
    }>;
    recentWorkLogs: Array<{
      projectName: string;
      primaryDomain: string;
      taskSummary: string;
    }>;
    domainFocusMinutes: Record<string, number>;
    dueCardsCount: number;
    weeklyHoursTarget: number;
  };

  try {
    const skillText = (skills || [])
      .map(
        (s) =>
          `- [${s.domain} | ${s.tier} | Priority: ${s.priority} | Mastery: ${s.mastery}% | Reps: ${s.practiceCount}] ${s.title}`
      )
      .join('\n');

    const projectBlock = activeProject
      ? `ACTIVE PROJECT PRIORITY OVERRIDE:
- Project: ${activeProject.projectName} (${activeProject.primaryDomain})
- Mastery Goal: ${activeProject.masteryGoal}
- Task Brief: ${(activeProject.rawTaskBrief || '').slice(0, 1500)}
- Master Syllabus Modules:
${(activeProject.masterSyllabusModules || [])
  .map((m) => `  * [${m.domain}] ${m.title}: ${m.objective} (Internals: ${m.keyInternals})`)
  .join('\n')}`
      : `NORMAL ROUTINE MODE:
- Scheduled Rotation Slot Today: ${todaySlot}
- Weekly Budget: ${weeklyHoursTarget || 10} hrs/week | Due SM-2 Cards: ${dueCardsCount || 0}
- Focus Minutes This Week: ${JSON.stringify(domainFocusMinutes || {})}`;

    const logsBlock = (recentWorkLogs || [])
      .slice(0, 6)
      .map((l) => `- [${l.primaryDomain}] ${l.projectName}: ${l.taskSummary.slice(0, 150)}`)
      .join('\n');

    const response = await generateWithModelFallback({
      model: 'gemini-4-hydrogen',
      contents: `Date: ${dateKey}
Operating Mode: ${mode}

${projectBlock}

Current Skill Matrix:
${skillText}

Recent Work Telemetry:
${logsBlock || 'None yet.'}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        systemInstruction:
          'You are "The System" generating today’s automatic Daily Quests for an Associate Cloud Engineer striving for Top 1% mastery. When mode is project_override, dedicate 3 quests to shipping the active project AND mastering its primaryDomain to Top 1% internals, plus 1 Active Recall quest. When mode is normal_routine, target todaySlot (or the lowest-mastery domain if todaySlot is Multi-Cloud Synthesis / Review & Gap Audit) and prescribe 4 high-leverage Top 1% daily quests so the engineer levels up systematically without manual planning. Keep checklist steps crisp, technical, and verifiable (3-4 items per quest), estimatedMinutes between 15 and 90, and xpReward between 25 and 150.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            systemDirective: {
              type: Type.STRING,
              description:
                'Sharp 1-2 sentence System briefing explaining today’s priority and Top 1% mastery target.',
            },
            focusDomain: {
              type: Type.STRING,
              enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
            },
            dailyQuests: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  questType: {
                    type: Type.STRING,
                    enum: [
                      'Project Execution',
                      'Domain Mastery',
                      'Production Drill',
                      'Active Recall',
                    ],
                  },
                  rank: {
                    type: Type.STRING,
                    enum: ['E-Rank', 'D-Rank', 'C-Rank', 'B-Rank', 'A-Rank', 'S-Rank'],
                  },
                  title: { type: Type.STRING },
                  objective: { type: Type.STRING },
                  masteryChecklist: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING },
                  },
                  linkedSkillTitle: { type: Type.STRING },
                  estimatedMinutes: { type: Type.INTEGER },
                  xpReward: { type: Type.INTEGER },
                },
                required: [
                  'domain',
                  'questType',
                  'rank',
                  'title',
                  'objective',
                  'masteryChecklist',
                  'linkedSkillTitle',
                  'estimatedMinutes',
                  'xpReward',
                ],
              },
            },
          },
          required: ['systemDirective', 'focusDomain', 'dailyQuests'],
        },
      },
    });

    const parsed = parseJsonResponse(response.text, 'system-daily-quests');
    const fallbackDomain = activeProject
      ? normalizeDomain(activeProject.primaryDomain, activeProject.projectName, 'AWS')
      : normalizeDomain(todaySlot, todaySlot, 'Angular');

    const focusDomain = normalizeDomain(parsed.focusDomain, todaySlot, fallbackDomain);
    const rawQuests = Array.isArray(parsed.dailyQuests) ? parsed.dailyQuests : [];
    const dailyQuests = rawQuests
      .filter((q): q is Record<string, unknown> => Boolean(q && typeof q === 'object'))
      .slice(0, 5)
      .map((q, idx) => {
        const checklist = Array.isArray(q.masteryChecklist)
          ? q.masteryChecklist.map((c) => asString(c)).filter(Boolean).slice(0, 6)
          : [];
        return {
          domain: normalizeDomain(q.domain, `${asString(q.title)} ${asString(q.objective)}`, focusDomain),
          questType: normalizeEnum(
            q.questType,
            VALID_QUEST_TYPES,
            VALID_QUEST_TYPES[idx % VALID_QUEST_TYPES.length]
          ),
          rank: normalizeEnum(q.rank, VALID_QUEST_RANKS, 'B-Rank'),
          title: asString(q.title, `${focusDomain} Daily Mastery Quest ${idx + 1}`),
          objective: asString(q.objective, `Advance Top 1% readiness in ${focusDomain}.`),
          masteryChecklist:
            checklist.length > 0
              ? checklist
              : ['Review internal architecture', 'Execute hands-on check', 'Verify edge-case handling'],
          linkedSkillTitle: asString(q.linkedSkillTitle, skills?.[0]?.title || focusDomain),
          estimatedMinutes: Math.min(
            240,
            Math.max(5, Math.round(Number(q.estimatedMinutes) || 40))
          ),
          xpReward: Math.min(300, Math.max(10, Math.round(Number(q.xpReward) || 60))),
        };
      });

    if (dailyQuests.length === 0) {
      dailyQuests.push({
        domain: focusDomain,
        questType: mode === 'project_override' ? 'Project Execution' : 'Domain Mastery',
        rank: 'B-Rank',
        title: `${focusDomain} Deep Internals Sprint`,
        objective: `Execute a focused 45-minute engineering sprint in ${focusDomain}.`,
        masteryChecklist: [
          'Identify highest-leverage failure mode',
          'Implement and test concrete fix',
          'Summarize key invariant learned',
        ],
        linkedSkillTitle: skills.find((s) => s.domain === focusDomain)?.title || focusDomain,
        estimatedMinutes: 45,
        xpReward: 75,
      });
    }

    res.json({
      systemDirective: asString(
        parsed.systemDirective,
        `Today's focus is ${focusDomain} toward Top 1% production mastery.`
      ),
      focusDomain,
      dailyQuests,
    });
  } catch (error) {
    if (isQuotaOrBillingError(error)) {
      console.warn('[system-daily-quests] Gemini quota/credits unavailable; issuing local routine quests.');
      res.json(
        buildStructuredDailyQuests({
          todaySlot: todaySlot || 'AWS',
          mode: mode || 'normal_routine',
          activeProject,
          skills: skills || [],
        })
      );
      return;
    }
    handleAiError(res, error, 'system-daily-quests');
  }
});

app.post('/api/ai/generate-brief', async (req, res) => {
  const { domain, title, tier, description } = (req.body || {}) as {
    domain: string;
    title: string;
    tier: string;
    description: string;
  };

  if (!domain || !title) {
    res.status(400).json({ error: 'Domain and skill title are required.' });
    return;
  }

  try {
    const response = await generateWithModelFallback({
      model: 'gemini-4-hydrogen',
      contents: `Generate a Top 1% Staff-level study brief and hands-on lab for:
Domain: ${domain}
Skill: ${title}
Target Tier: ${tier}
Context: ${description}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.XHIGH },
        systemInstruction:
          'Write a razor-sharp engineering study brief without fluff. Focus on internals, failure modes, trade-offs, production pitfalls, and verification commands/patterns that separate top 1% engineers from average practitioners.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            studyBrief: {
              type: Type.STRING,
              description:
                'Structured markdown-free or clean plain-text technical brief covering internals, failure modes, and architectural trade-offs (under 3500 chars).',
            },
            labPrompt: {
              type: Type.STRING,
              description: 'A concrete 45-minute hands-on engineering lab exercise with clear acceptance criteria.',
            },
          },
          required: ['studyBrief', 'labPrompt'],
        },
      },
    });

    const parsed = JSON.parse((response.text ?? '{}').trim());
    res.json(parsed);
  } catch (error) {
    if (isQuotaOrBillingError(error)) {
      console.warn('[generate-brief] Gemini quota/credits unavailable; returning structured study brief.');
      res.json(buildStructuredStudyBrief({ domain, title, tier: tier || 'Top 1%', description: description || '' }));
      return;
    }
    handleAiError(res, error, 'generate-brief');
  }
});

app.post('/api/ai/drill-step', async (req, res) => {
  try {
    const { mode, domain, difficulty, scenarioPrompt, messages } = req.body as {
      mode: 'start' | 'respond' | 'evaluate';
      domain: string;
      difficulty: 'Senior' | 'Staff' | 'Principal';
      scenarioPrompt?: string;
      messages?: Array<{ role: 'assistant' | 'user'; content: string }>;
    };

    const ai = getAiClient();

    if (mode === 'start') {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Create a high-realism ${difficulty}-level production incident or architecture review drill in the ${domain} domain.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          systemInstruction:
            'You are a Principal SRE & Cloud Architect running a live war-room or architecture review simulation for an Associate Cloud Engineer aiming for Top 1% mastery. Present realistic telemetry/constraints, an urgent production symptom or design requirement, and ask the candidate for their immediate diagnostic or architectural plan.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: { type: Type.STRING },
              scenarioPrompt: {
                type: Type.STRING,
                description: 'Detailed scenario briefing with architecture context, metrics, and constraints.',
              },
              initialChallenge: {
                type: Type.STRING,
                description: 'Direct first question to kick off the multi-turn drill.',
              },
            },
            required: ['title', 'scenarioPrompt', 'initialChallenge'],
          },
        },
      });
      res.json(JSON.parse((response.text ?? '{}').trim()));
      return;
    }

    const transcript = (messages || [])
      .map((m) => `${m.role === 'assistant' ? 'Principal Reviewer' : 'Engineer'}: ${m.content}`)
      .join('\n\n');

    if (mode === 'respond') {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Scenario Context (${domain} · ${difficulty}):
${scenarioPrompt}

Conversation Transcript:
${transcript}

Provide your next incisive Principal Reviewer turn. Acknowledge strong points briefly, then introduce a deeper twist, hidden failure mode, blast-radius concern, or trade-off probe.`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          systemInstruction:
            'Stay in role as a demanding yet constructive Principal Engineer. Keep responses crisp, concrete, and focused on internals, reliability, security, and cost/latency trade-offs.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              reply: { type: Type.STRING },
            },
            required: ['reply'],
          },
        },
      });
      res.json(JSON.parse((response.text ?? '{}').trim()));
      return;
    }

    if (mode === 'evaluate') {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: `Evaluate the engineer's performance in this ${difficulty}-level ${domain} drill.

Scenario:
${scenarioPrompt}

Transcript:
${transcript}`,
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          systemInstruction:
            'Grade strictly against a Top 1% Staff Engineer rubric across Architecture, Reliability, Security, and Performance/Cost (0 to 100 each). Be fair but calibrated: reward deep root-cause reasoning, blast-radius thinking, and concrete mitigations; flag hand-waving.',
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              overallScore: { type: Type.INTEGER },
              architectureScore: { type: Type.INTEGER },
              reliabilityScore: { type: Type.INTEGER },
              securityScore: { type: Type.INTEGER },
              performanceScore: { type: Type.INTEGER },
              strengths: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              gaps: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              nextSteps: {
                type: Type.STRING,
                description: 'Concrete post-mortem action plan for reaching Top 1% on this scenario.',
              },
            },
            required: [
              'overallScore',
              'architectureScore',
              'reliabilityScore',
              'securityScore',
              'performanceScore',
              'strengths',
              'gaps',
              'nextSteps',
            ],
          },
        },
      });
      res.json(JSON.parse((response.text ?? '{}').trim()));
      return;
    }

    res.status(400).json({ error: 'Invalid drill mode.' });
  } catch (error) {
    handleAiError(res, error, 'drill-step');
  }
});

app.post('/api/ai/generate-quiz', async (req, res) => {
  try {
    const { domain, topic, existingPrompts } = req.body as {
      domain: 'Angular' | 'FastAPI' | 'DevOps' | 'AWS' | 'GCP';
      topic?: string;
      existingPrompts?: string[];
    };

    const ai = getAiClient();
    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: `Generate 3 Top 1% spaced-repetition technical cards for domain: ${domain}.
Focus Topic: ${topic || 'Deep production internals, failure modes, and subtle edge cases'}
Avoid duplicating these existing prompts:
${(existingPrompts || []).slice(0, 15).join('\n')}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
        systemInstruction:
          'Design high-signal active-recall questions that test deep understanding rather than trivia—e.g., debugging a subtle async deadlock, IAM trust boundary, hydration mismatch, K8s scheduling constraint, or multi-cloud egress bottleneck.',
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            cards: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  domain: {
                    type: Type.STRING,
                    enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  skillTitle: { type: Type.STRING },
                  prompt: { type: Type.STRING },
                  answer: { type: Type.STRING },
                  explanation: { type: Type.STRING },
                },
                required: ['domain', 'skillTitle', 'prompt', 'answer', 'explanation'],
              },
            },
          },
          required: ['cards'],
        },
      },
    });

    res.json(JSON.parse((response.text ?? '{}').trim()));
  } catch (error) {
    handleAiError(res, error, 'generate-quiz');
  }
});

type JarvisPage = 'quests' | 'roadmaps' | 'upload' | 'profile';
type JarvisInteractiveMode = 'mentor' | 'walkthrough' | 'quiz';
type JarvisAction =
  | { type: 'navigate'; page: JarvisPage; domainFilter?: Domain | 'All' }
  | { type: 'open_skill'; skillTitle: string; domain?: Domain }
  | { type: 'focus_quest'; questIdOrTitle: string }
  | { type: 'complete_quest'; questIdOrTitle: string }
  | { type: 'refresh_study_brief'; skillTitle: string; domain?: Domain }
  | { type: 'prefill_upload'; projectName?: string; rawTaskBrief?: string }
  | { type: 'refresh_quests' }
  | {
      type: 'structure_syllabus';
      summary: string;
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
  | { type: 'award_skill_practice'; skillTitle: string; domain?: Domain; masteryBoost?: number }
  | { type: 'design_roadmap'; domain: Domain | 'All'; focusGoal?: string }
  | {
      type: 'mark_job_task_done';
      projectName: string;
      domain?: Domain;
      taskSummary?: string;
      resumePath?: boolean;
    }
  | { type: 'close_skill_drawer' };

interface JarvisSkillContext {
  domain: string;
  title: string;
  tier: string;
  priority: string;
  mastery: number;
  description?: string;
  studyBrief?: string;
  labPrompt?: string;
}

interface JarvisQuestContext {
  id: string;
  title: string;
  domain: string;
  questType: string;
  rank: string;
  status: string;
  objective: string;
  masteryChecklist: string[];
  linkedSkillTitle: string;
  estimatedMinutes: number;
  xpReward: number;
}

interface JarvisProjectContext {
  projectName: string;
  primaryDomain: string;
  domains: string[];
  rank: string;
  masteryGoal: string;
  masterSyllabusModules: Array<{
    title: string;
    domain: string;
    tier?: string;
    objective: string;
    keyInternals: string;
    verificationCriteria: string;
  }>;
}

interface JarvisKnowledgeEntry {
  keywords: string[];
  domain: Domain;
  topic: string;
  explanation: string;
  codeSnippet: string;
  quizQuestion: string;
  quizExpectedConcepts: string[];
}

const JARVIS_TECH_KB: JarvisKnowledgeEntry[] = [
  {
    keywords: ['zoneless', 'zone.js', 'providezonelesschangedetection', 'change detection', 'modern angular'],
    domain: 'Angular',
    topic: 'Angular Zoneless Change Detection',
    explanation:
      'Zoneless Angular (`provideZonelessChangeDetection()`) removes Zone.js monkey-patching of timers, XHR, and Promises. Angular schedules targeted view dirtying strictly from `signal()` writes read in templates, `AsyncPipe`, DOM event bindings, and explicit `ChangeDetectorRef.markForCheck()`. Pitfall: mutating plain object fields inside `setTimeout` or `fetch` callbacks leaves the UI stale until a signal updates.',
    codeSnippet: `bootstrapApplication(AppComponent, {
  providers: [provideZonelessChangeDetection(), provideHttpClient(withInterceptors([retryInterceptor]))]
});

// Signal-driven state ensures zoneless UI updates cleanly
readonly builds = signal<BuildStage[]>([]);
readonly completedCount = computed(() => this.builds().filter(b => b.done).length);`,
    quizQuestion:
      'In a zoneless Angular component, you update a plain property `this.status = "ready"` inside a `setTimeout` callback without using a Signal or `markForCheck()`. What happens to the rendered DOM, and how do you fix it?',
    quizExpectedConcepts: ['signal', 'markforcheck', 'stale', 'not update', 'zone.js'],
  },
  {
    keywords: ['signal', 'computed', 'effect', 'tosignal', 'toobservable', 'switchmap', 'exhaustmap', 'rxjs'],
    domain: 'Angular',
    topic: 'Signals & RxJS Interop (switchMap vs exhaustMap)',
    explanation:
      'Use `signal()` for mutable sync state, `computed()` for glitch-free derived values, and `effect()` strictly for external side effects (logging, storage, DOM sync). For RxJS streams: `switchMap` cancels prior in-flight requests (ideal for typeahead/filters), whereas `exhaustMap` drops new clicks until the current request settles (ideal for form submits & credit deductions).',
    codeSnippet: `private search$ = toObservable(this.query).pipe(
  debounceTime(200),
  switchMap(q => this.api.search(q).pipe(catchError(() => of([]))))
);
readonly results = toSignal(this.search$, { initialValue: [] });`,
    quizQuestion:
      'When triggering a billing or build-launch POST request from a button stream, why choose `exhaustMap` instead of `switchMap`?',
    quizExpectedConcepts: ['duplicate', 'cancel', 'ignore', 'in-flight', 'double'],
  },
  {
    keywords: ['interceptor', 'retry', 'backoff', 'jitter', '502', '503', 'idempotent'],
    domain: 'Angular',
    topic: 'Resilient HTTP Interceptor & Full-Jitter Backoff',
    explanation:
      'Restrict automatic retries to idempotent methods (`GET`, `HEAD`, `OPTIONS`) or requests carrying an explicit `Idempotency-Key` header on transient `0`, `502`, `503`, `504` errors. Apply Full Jitter (`random(0, min(capMs, baseMs * 2^attempt))`) so disconnected tabs do not synchronize retry storms against FastAPI/ALB.',
    codeSnippet: `return next(req).pipe(
  retry({
    count: 3,
    delay: (err, attempt) => {
      const retryable = ['GET', 'HEAD'].includes(req.method) || req.headers.has('Idempotency-Key');
      if (!retryable || ![0, 502, 503, 504].includes(err.status)) throw err;
      const cap = Math.min(8000, 400 * 2 ** (attempt - 1));
      return timer(Math.floor(Math.random() * cap));
    }
  })
);`,
    quizQuestion:
      'If your HTTP retry interceptor retries a `POST /api/builds` that timed out at the ALB (`504`) after hitting FastAPI, what production hazard occurs without an `Idempotency-Key`?',
    quizExpectedConcepts: ['duplicate', 'double', 'charge', 'twice', 'side effect'],
  },
  {
    keywords: ['multipart', 'presigned', 's3', 'upload', 'chunk', 'slice'],
    domain: 'AWS',
    topic: 'Direct-to-S3 Multipart Upload',
    explanation:
      'Stream multi-GB datasets straight from browser to S3 via presigned `UploadPart` URLs so FastAPI workers never buffer files in RAM. Slice with `File.slice` (>=5MB parts except last), cap concurrency at 4–6 parallel PUTs via a semaphore, store each returned `ETag` (remember `ExposeHeaders: ["ETag"]` in S3 CORS!), and finalize with `CompleteMultipartUpload`.',
    codeSnippet: `// Semaphore-capped concurrent part uploads
const etags: Array<{ PartNumber: number; ETag: string }> = [];
for (const part of presignedParts) {
  const chunk = file.slice(part.start, part.end);
  const res = await fetch(part.url, { method: 'PUT', body: chunk, signal: abortCtrl.signal });
  etags.push({ PartNumber: part.partNumber, ETag: res.headers.get('ETag')! });
}`,
    quizQuestion:
      'Your browser direct-to-S3 multipart PUT succeeds with 200 OK, yet `res.headers.get("ETag")` returns `null` in JS, causing `CompleteMultipartUpload` to fail. Which S3 CORS setting fixes this?',
    quizExpectedConcepts: ['exposeheaders', 'etag', 'cors', 'expose'],
  },
  {
    keywords: ['sse', 'eventsource', 'server-sent', 'polling', '22-stage', 'stream'],
    domain: 'Angular',
    topic: 'Real-Time SSE + Adaptive Polling Fallback',
    explanation:
      'Server-Sent Events carry automatic browser reconnects with `Last-Event-ID`. Emit `: keepalive\\n\\n` comments every 15s so ALB/CloudFront idle timeouts do not kill quiet connections, and degrade cleanly to adaptive polling (`2s → 5s → 15s`) after consecutive SSE errors.',
    codeSnippet: `const es = new EventSource(\`/api/v1/builds/\${id}/events\`);
es.addEventListener('stage', (e) => stageSignal.set(JSON.parse(e.data)));
es.onerror = () => {
  es.close();
  startAdaptivePolling(id); // 2s -> 5s -> 15s backoff
};`,
    quizQuestion:
      'Why do idle SSE streams through AWS ALB or CloudFront drop after 60 seconds unless the server emits `: keepalive` comments?',
    quizExpectedConcepts: ['idle', 'timeout', 'proxy', 'alb', '60'],
  },
  {
    keywords: ['depends', 'dependency injection', 'lifespan', 'asynccontextmanager', 'pydantic', 'fastapi'],
    domain: 'FastAPI',
    topic: 'FastAPI Lifespan, DI DAG & Pydantic v2',
    explanation:
      'Initialize connection pools (asyncpg, HTTPX, aioboto3) inside `@asynccontextmanager async def lifespan(app)` and attach them to `app.state` so sockets reuse cleanly across requests and flush on SIGTERM. Compose request validation, tenant resolution, and RBAC checks as layered `Depends()` functions (cached per-request by default).',
    codeSnippet: `@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.db_pool = await asyncpg.create_pool(settings.DATABASE_URL, min_size=5, max_size=20)
    try:
        yield
    finally:
        await app.state.db_pool.close()`,
    quizQuestion:
      'What goes wrong under load if a FastAPI route creates a brand-new `httpx.AsyncClient()` or database engine per request instead of managing it in `lifespan`?',
    quizExpectedConcepts: ['exhaust', 'pool', 'socket', 'connection', 'latency', 'leak'],
  },
  {
    keywords: ['for update', 'acid', 'credit', 'double-spend', 'idempotency', 'row lock', 'concurrency'],
    domain: 'FastAPI',
    topic: 'ACID Credit Reservation (`SELECT ... FOR UPDATE`)',
    explanation:
      'Prevent race-condition double spending by starting a DB transaction, checking `(tenant_id, idempotency_key)` first, locking the account row via `SELECT balance FROM wallets WHERE tenant_id = :t FOR UPDATE`, verifying funds, deducting, and committing. Never hold a `FOR UPDATE` row lock across external S3/SQS network calls.',
    codeSnippet: `async with db.begin():
    existing = await db.execute(select(IdempotencyRecord).where(IdempotencyRecord.key == idem_key))
    if row := existing.scalar_one_or_none():
        return row.cached_response
    wallet = (await db.execute(select(Wallet).where(Wallet.tenant_id == tenant_id).with_for_update())).scalar_one()
    if wallet.credits < cost:
        raise HTTPException(402, "Insufficient credits")
    wallet.credits -= cost`,
    quizQuestion:
      'Why is checking `if wallet.credits >= cost` in Python BEFORE updating without `SELECT ... FOR UPDATE` unsafe when two concurrent POST requests hit FastAPI simultaneously?',
    quizExpectedConcepts: ['race', 'both read', 'double', 'stale', 'dirty', 'serialize'],
  },
  {
    keywords: ['rbac', 'multi-tenant', 'tenant', 'viewer', 'admin', 'member'],
    domain: 'FastAPI',
    topic: 'Multi-Tenant RBAC Dependencies',
    explanation:
      'Use a closure dependency factory `require_role({"admin", "member"})` chained after JWT verification and tenant membership lookup. Always enforce `tenant_id == ctx.tenant_id` in SQL queries (or Postgres RLS) rather than checking ownership in Python after fetching rows.',
    codeSnippet: `def require_role(*allowed: str):
    async def checker(ctx: TenantContext = Depends(get_tenant_context)) -> TenantContext:
        if ctx.role not in allowed:
            raise HTTPException(status_code=403, detail="Insufficient role for tenant")
        return ctx
    return checker`,
    quizQuestion:
      'How do you guarantee a multi-tenant FastAPI service never leaks Tenant B records even if a developer forgets `.where(Model.tenant_id == ctx.tenant_id)`?',
    quizExpectedConcepts: ['rls', 'row level security', 'repository', 'base query', 'session'],
  },
  {
    keywords: ['sqs', 'fifo', 'long polling', 'waittimeseconds', 'emptyreceives', 'visibility', 'heartbeat', 'changemessagevisibility', 'dlq', 'redrive', 'poison'],
    domain: 'AWS',
    topic: 'AWS SQS Long Polling, Visibility Heartbeat & DLQ',
    explanation:
      '1) `WaitTimeSeconds=20` activates Long Polling: SQS waits up to 20s before returning empty, cutting API costs by >95%. `NumberOfEmptyReceives` hitting 30+ over 10m proves pollers are alive and polling an idle queue, while `ApproximateNumberOfMessagesVisible = 0` means workers keep pace cleanly.\n2) For jobs longer than `VisibilityTimeout`, spawn an async heartbeat calling `ChangeMessageVisibility` every 15s (before lock expiry) so duplicate workers never grab the message.\n3) Set `maxReceiveCount=3` to send poison pills to a DLQ; inspect root causes before replaying via redrive.',
    codeSnippet: `async def heartbeat(sqs, queue_url: str, receipt: str, stop: asyncio.Event):
    while not stop.is_set():
        await asyncio.sleep(15)
        if not stop.is_set():
            await sqs.change_message_visibility(QueueUrl=queue_url, ReceiptHandle=receipt, VisibilityTimeout=45)`,
    quizQuestion:
      'Your CloudWatch dashboard shows `ApproximateNumberOfMessagesVisible = 0` and `NumberOfEmptyReceives = 35`. Is your SQS worker broken or healthy, and why?',
    quizExpectedConcepts: ['healthy', 'long polling', 'wait', 'fast', 'idle', 'active'],
  },
  {
    keywords: ['traceparent', 'opentelemetry', 'otel', 'tracing', 'w3c'],
    domain: 'DevOps',
    topic: 'Distributed Tracing Across SQS (W3C traceparent)',
    explanation:
      'Async queues strip HTTP headers. Use `opentelemetry.propagate.inject(carrier)` when publishing to serialize `traceparent` into SQS `MessageAttributes`, and `propagate.extract(carrier)` inside the SQS consumer to link HTTP → Worker → Argo Workflow spans into one flamegraph.',
    codeSnippet: `carrier = {}
propagate.inject(carrier)
await sqs.send_message(
    QueueUrl=queue_url,
    MessageBody=payload,
    MessageAttributes={k: {"DataType": "String", "StringValue": v} for k, v in carrier.items()}
)`,
    quizQuestion:
      'Why must `traceparent` be placed inside SQS `MessageAttributes` rather than only in HTTP request headers?',
    quizExpectedConcepts: ['async', 'decouple', 'http ends', 'boundary', 'propagate'],
  },
  {
    keywords: ['argo', 'crd', 'workflow', 'workflowtemplate', 'customobjectsapi', 'pod-proxy', 'keda', 'scaledobject'],
    domain: 'DevOps',
    topic: 'Argo Workflows CRDs, Pod-Proxy & KEDA Autoscaling',
    explanation:
      'Submit and watch Argo `Workflow` CRDs programmatically via Kubernetes Python `CustomObjectsApi` (`argoproj.io/v1alpha1`). Enforce per-step `requests`/`limits` (1vCPU/2GB up to 8vCPU/16GB) + `ttlStrategy` so finished pods don’t bloat etcd, and use KEDA `ScaledObject` targeting SQS depth to scale workers 2 → 10 replicas automatically.',
    codeSnippet: `custom_api.create_namespaced_custom_object(
    group="argoproj.io",
    version="v1alpha1",
    namespace="compute",
    plural="workflows",
    body=workflow_manifest,
)`,
    quizQuestion:
      'Why does KEDA SQS scaling avoid cold-start lag better than standard Kubernetes CPU HPA for queue-backed build workers?',
    quizExpectedConcepts: ['queue depth', 'before cpu', 'backlog', 'proactive', 'lag'],
  },
  {
    keywords: ['duckdb', 'pyarrow', 'zero-copy', 'profiler', 'quantile', 'cardinality', '512mb', 'data engineering'],
    domain: 'FastAPI',
    topic: 'Zero-Copy S3 Profiling under 512MB RAM (DuckDB + PyArrow)',
    explanation:
      'DuckDB `httpfs` reads Parquet footers and streams only requested byte ranges directly from S3 with zero local disk download. Under a strict `512MB` pod limit, cap DuckDB memory (`SET memory_limit=\'360MB\'`), limit threads (`SET threads=2`), and compute single-pass `approx_count_distinct` + `approx_quantile` so large datasets never OOMKill.',
    codeSnippet: `con = duckdb.connect(":memory:")
con.execute("INSTALL httpfs; LOAD httpfs; SET memory_limit='360MB'; SET threads=2;")
stats = con.execute("""
  SELECT COUNT(*) AS rows, APPROX_COUNT_DISTINCT(user_id) AS card,
         APPROX_QUANTILE(latency_ms, [0.25, 0.5, 0.75, 0.95]) AS q
  FROM read_parquet('s3://bucket/dataset.parquet')
""").fetchall()`,
    quizQuestion:
      'How does DuckDB profile a 20GB Parquet file in S3 inside a 512MB RAM container without OOMKilling?',
    quizExpectedConcepts: ['range', 'column', 'projection', 'memory_limit', 'approx', 'stream'],
  },
  {
    keywords: ['alb', 'ingress', 'cors', 'cloudfront', 'options', 'preflight', 'irsa', 'permission boundary', 'accessdenied', 'prestop', 'readinessprobe', 'startupprobe', 'zero-downtime'],
    domain: 'DevOps',
    topic: 'EKS ALB Ingress, CORS, IRSA Boundaries & Zero-Downtime Rollouts',
    explanation:
      '1) CORS across CloudFront + ALB: forward `Origin` & `Access-Control-Request-*` headers so `OPTIONS` preflight isn’t stripped before FastAPI.\n2) IRSA `AccessDeniedException`: effective IAM permissions = `Role Policy ∩ Permission Boundary`. Updating only the Role policy fails if the Permission Boundary omits `sqs:SendMessage` or `s3:PutObject`.\n3) Zero-downtime rollouts: combine `startupProbe`, `readinessProbe`, and `preStop: sleep 5` so Kubernetes drains the pod IP from ALB target groups BEFORE sending `SIGTERM`.',
    codeSnippet: `lifecycle:
  preStop:
    exec:
      command: ["sh", "-c", "sleep 5"]
readinessProbe:
  httpGet: { path: /healthz, port: 8000 }
  periodSeconds: 5`,
    quizQuestion:
      'During a rolling deployment on EKS, why do brief 502 errors occur if you omit `preStop: sleep 5` even though `readinessProbe` is configured?',
    quizExpectedConcepts: ['race', 'sigterm', 'alb', 'endpoint', 'deregister', 'in-flight'],
  },
  {
    keywords: ['migration', 'not null', 'table lock', 'alter table', 'backfill', 'postgres', 'rds'],
    domain: 'FastAPI',
    topic: 'Zero-Lock 3-Step PostgreSQL Migration Pattern',
    explanation:
      'Adding a constrained/backfilled column naively can acquire an `ACCESS EXCLUSIVE` lock and block live traffic. Safe 3-step rollout: (1) `ADD COLUMN vcpu INT NULL` (instant metadata change); (2) batched backfill (`LIMIT 5000` loops) + dual-write in code; (3) `ADD CONSTRAINT ... CHECK (vcpu IS NOT NULL) NOT VALID`, followed by `VALIDATE CONSTRAINT` (concurrent `SHARE UPDATE EXCLUSIVE` lock).',
    codeSnippet: `-- Step 1: instant nullable add
ALTER TABLE builds ADD COLUMN vcpu INT;
-- Step 2: batched backfill in app/script (5k rows/tx)
-- Step 3: non-blocking validation
ALTER TABLE builds ADD CONSTRAINT builds_vcpu_nn CHECK (vcpu IS NOT NULL) NOT VALID;
ALTER TABLE builds VALIDATE CONSTRAINT builds_vcpu_nn;`,
    quizQuestion:
      'Why does adding `CHECK (...) NOT VALID` followed by `VALIDATE CONSTRAINT` avoid production downtime compared to a direct `SET NOT NULL` on a 50M-row Postgres table?',
    quizExpectedConcepts: ['lock', 'access exclusive', 'read', 'write', 'concurrent', 'scan'],
  },
  {
    keywords: ['oidc', 'pkce', 'keycloak', 'client credentials', 'm2m', 'oauth', 'security'],
    domain: 'DevOps',
    topic: 'Enterprise OIDC: Auth Code + PKCE & Client Credentials',
    explanation:
      'Browser SPAs are public clients — never embed a `client_secret`. Use Authorization Code + PKCE (`code_verifier` → SHA-256 `code_challenge`) so intercepted auth codes cannot be redeemed. For backend service-to-service calls (`dataset-profiler` → `meridian-api`), use OAuth2 `client_credentials` with short-lived JWTs verified via Keycloak JWKS.',
    codeSnippet: `// Browser PKCE verifier -> challenge
const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
const challenge = base64Url(new Uint8Array(digest));`,
    quizQuestion:
      'In an Angular SPA using Keycloak, why is PKCE mandatory even though HTTPS encrypts traffic?',
    quizExpectedConcepts: ['public client', 'secret', 'intercept', 'authorization code', 'redirect'],
  },
  {
    keywords: ['gcp', 'cloud run', 'gke', 'workload identity', 'pub/sub', 'bigquery'],
    domain: 'GCP',
    topic: 'GCP Cloud Run, GKE Workload Identity & Pub/Sub',
    explanation:
      'Bind Kubernetes ServiceAccounts to Google IAM via Workload Identity Federation (zero static JSON keys). Set Pub/Sub `ackDeadlineSeconds` beyond job runtime + attach a Dead-Letter Topic (`maxDeliveryAttempts`), and disable CPU throttling on Cloud Run if handling async background work.',
    codeSnippet: `# Bind GKE KSA to Google Service Account via Workload Identity
gcloud iam service-accounts add-iam-policy-binding gsa@project.iam.gserviceaccount.com \\
  --role roles/iam.workloadIdentityUser \\
  --member "serviceAccount:project.svc.id.goog[compute/worker-ksa]"`,
    quizQuestion:
      'What happens in GCP Pub/Sub if a worker takes 90 seconds to process a message whose `ackDeadlineSeconds` is 30 seconds without extending the ack deadline?',
    quizExpectedConcepts: ['redeliver', 'duplicate', 'expire', 'another worker', 'nack'],
  },
  {
    keywords: ['ssr', 'hydration', 'defer', 'transferstate', 'event replay', 'core web vitals', 'inp'],
    domain: 'Angular',
    topic: 'Angular SSR, Event Replay & Incremental Hydration',
    explanation:
      'Prevent duplicate HTTP waterfalls during SSR hydration by caching server responses in `TransferState` (enabled via `withHttpTransferCacheOptions`). Use `withEventReplay()` so user clicks during hydration replay cleanly, and isolate heavy charts/tables inside `@defer (on viewport; hydrate on interaction)` boundaries to protect INP.',
    codeSnippet: `export const appConfig: ApplicationConfig = {
  providers: [
    provideClientHydration(withEventReplay(), withIncrementalHydration()),
    provideHttpClient(withFetch()),
  ],
};`,
    quizQuestion:
      'How does `TransferState` prevent a hydrated Angular SSR component from issuing a duplicate `GET /api/metrics` request on browser boot?',
    quizExpectedConcepts: ['serialize', 'html', 'cache', 'server', 'deduplicate', 'reuse'],
  },
  {
    keywords: ['terraform', 'state', 'drift', 'opa', 'checkov', 'iac', 'blast radius'],
    domain: 'DevOps',
    topic: 'Terraform Layered State Architecture & Policy-as-Code',
    explanation:
      'Never keep org IAM, VPC networking, EKS/GKE clusters, and app workloads in one monolithic state file. Partition states by blast radius and change cadence with remote GCS/S3 locking, read upstream outputs via `terraform_remote_state` or SSM/Secret outputs, and gate `terraform plan` JSON in CI using OPA Conftest rules.',
    codeSnippet: `# OPA Rego rule blocking public S3 ACLs in Terraform plan
package terraform.s3
deny[msg] {
  rc := input.resource_changes[_]
  rc.type == "aws_s3_bucket_acl"
  rc.change.after.acl == "public-read"
  msg := sprintf("Public S3 ACL forbidden on %s", [rc.address])
}`,
    quizQuestion:
      'Why is storing VPC networking and application microservices in the same Terraform state file an operational risk at scale?',
    quizExpectedConcepts: ['blast radius', 'lock', 'contention', 'slow', 'accident', 'destroy'],
  },
  {
    keywords: ['slo', 'sli', 'error budget', 'burn rate', 'prometheus', 'promql', 'alerting'],
    domain: 'DevOps',
    topic: 'SLO Error Budgets & Multi-Window Burn-Rate Alerting',
    explanation:
      'Alert on user-facing availability/latency error budget consumption instead of noisy CPU spikes. Pair a short and long window (e.g., 1h burn rate > 14.4x AND 5m burn rate > 14.4x for 2% budget burn) so paging triggers immediately on real outages while auto-resolving fast when traffic recovers.',
    codeSnippet: `# Multi-window 2% error-budget burn alert (99.9% SLO -> budget 0.001)
(
  job:http_requests_5xx:ratio_rate1h > (14.4 * 0.001)
  and
  job:http_requests_5xx:ratio_rate5m > (14.4 * 0.001)
)`,
    quizQuestion:
      'Why do production SRE teams require BOTH a 1-hour and a 5-minute burn-rate condition in a single PromQL SLO page rule?',
    quizExpectedConcepts: ['reset', 'flap', 'noise', 'sustained', 'fast', 'precision'],
  },
  {
    keywords: ['scp', 'organizations', 'permission boundary', 'iam evaluation', 'sts', 'transit gateway', 'privatelink', 'vpc endpoint'],
    domain: 'AWS',
    topic: 'AWS IAM Evaluation Chain, SCPs & PrivateLink Architecture',
    explanation:
      'Effective AWS authorization is the intersection (not union) of Identity Policy, Resource Policy, Permission Boundary, Session Policy, and Organizations SCP — any explicit Deny wins everywhere. For zero-internet-egress workloads, route S3/SecretsManager/STS through VPC Interface/Gateway Endpoints (PrivateLink) and interconnect VPCs via Transit Gateway with isolated route tables.',
    codeSnippet: `{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "DenyUnencryptedS3Put",
    "Effect": "Deny",
    "Action": "s3:PutObject",
    "Resource": "*",
    "Condition": { "StringNotEquals": { "s3:x-amz-server-side-encryption": "aws:kms" } }
  }]
}`,
    quizQuestion:
      'An IAM Role has `AdministratorAccess` attached, yet `s3:PutObject` fails with AccessDenied even though the bucket policy allows it. Name two higher-level policies that can block it.',
    quizExpectedConcepts: ['scp', 'permission boundary', 'session policy', 'vpc endpoint', 'explicit deny'],
  },
  {
    keywords: ['dynamodb', 'single-table', 'partition key', 'gsi', 'hot key', 'karpenter', 'prefix delegation'],
    domain: 'AWS',
    topic: 'DynamoDB Single-Table Design & EKS Karpenter Scale',
    explanation:
      'In DynamoDB single-table design, map every access pattern before choosing composite `PK`/`SK` keys and sparse GSIs, salting high-write partition keys to prevent 1,000 WCU/3,000 RCU hot-partition throttling. On EKS, enable VPC CNI prefix delegation (`/28` blocks) to avoid ENI IP exhaustion and let Karpenter consolidate underutilized nodes into Graviton spot/on-demand mixes.',
    codeSnippet: `// Composite single-table item modeling Tenant -> Orders -> LineItems
{
  PK: "TENANT#t_901",
  SK: "ORDER#2026-11-14#ord_442",
  GSI1PK: "STATUS#PENDING",
  GSI1SK: "2026-11-14T21:00:00Z"
}`,
    quizQuestion:
      'When using AWS EKS on smaller Nitro instances, why can pods get stuck in `Pending` due to IP exhaustion even when CPU and memory are 60% free, and how does VPC CNI prefix mode solve it?',
    quizExpectedConcepts: ['eni', 'secondary ip', 'prefix', '/28', '16', 'limit'],
  },
  {
    keywords: ['vpc-sc', 'vpc service controls', 'service perimeter', 'shared vpc', 'cloud armor', 'gateway api', 'bigquery', 'exfiltration'],
    domain: 'GCP',
    topic: 'GCP VPC Service Controls, Shared VPC & Cloud Armor',
    explanation:
      'IAM permissions alone cannot stop someone with stolen credentials from copying BigQuery or GCS data to an external attacker-owned GCP project. VPC Service Controls wrap Google-managed APIs in a context-aware perimeter enforcing access levels and egress rules. Pair with Shared VPC host/service separation, GKE Gateway API mTLS, and Cloud Armor adaptive L7 WAF.',
    codeSnippet: `# Create a dry-run VPC-SC perimeter protecting GCS & BigQuery
gcloud access-context-manager perimeters create prod_data_perimeter \\
  --title="Prod Data Perimeter" \\
  --resources="projects/1234567890" \\
  --restricted-services="storage.googleapis.com,bigquery.googleapis.com" \\
  --enable-vpc-accessible-services`,
    quizQuestion:
      'Why does IAM least-privilege alone fail to prevent data exfiltration from BigQuery/GCS when a developer laptop credential is leaked, and how does VPC Service Controls close that gap?',
    quizExpectedConcepts: ['perimeter', 'external project', 'network', 'context', 'copy', 'egress'],
  },
  {
    keywords: ['web worker', 'module federation', 'micro-frontend', 'ngrx', 'signalstore', 'bundle', 'memory leak', 'takeuntildestroyed'],
    domain: 'Angular',
    topic: 'Angular Web Workers, Memory Safety & Micro-Frontend Architecture',
    explanation:
      'Offload CPU-heavy JSON parsing, diffing, or CSV profiling off the main UI thread into dedicated Web Workers so INP stays under 100ms. Always pair imperative RxJS subscriptions with `takeUntilDestroyed(destroyRef)` to eliminate closure memory leaks across route transitions, and enforce strict shared singleton versions (`@angular/core`, `rxjs`) when composing Native/Module Federation remotes.',
    codeSnippet: `// Offload heavy telemetry parsing cleanly with takeUntilDestroyed
private readonly destroyRef = inject(DestroyRef);
readonly worker = new Worker(new URL('./telemetry.worker', import.meta.url));

ngOnInit() {
  fromEvent<MessageEvent>(this.worker, 'message')
    .pipe(takeUntilDestroyed(this.destroyRef))
    .subscribe(ev => this.rows.set(ev.data));
}`,
    quizQuestion:
      'In a dashboard rendering live 10Hz telemetry charts, why does moving aggregation into a Web Worker AND using `takeUntilDestroyed()` protect both INP and long-lived session memory?',
    quizExpectedConcepts: ['main thread', 'inp', 'block', 'unsubscribe', 'leak', 'destroy'],
  },
  {
    keywords: ['rate limit', 'token bucket', 'redis', 'backpressure', 'streamingresponse', 'semaphore', 'uvicorn'],
    domain: 'FastAPI',
    topic: 'FastAPI Backpressure, Streaming & Distributed Token-Bucket Rate Limiting',
    explanation:
      'Protect FastAPI workers from slowloris/burst starvation with Redis Lua-script atomic token-bucket rate limiting per `tenant_id` and bounded `asyncio.Semaphore` pools around downstream I/O. For large exports or LLM/SSE feeds, yield async chunks in `StreamingResponse` and always inspect `await request.is_disconnected()` so aborted clients free worker tasks immediately.',
    codeSnippet: `@app.get("/api/v1/export")
async def stream_export(request: Request):
    async def iter_rows():
        async for batch in fetch_batches():
            if await request.is_disconnected():
                break
            yield batch
    return StreamingResponse(iter_rows(), media_type="application/x-ndjson")`,
    quizQuestion:
      'Why must a long-lived FastAPI `StreamingResponse` / SSE generator check `await request.is_disconnected()` inside its loop?',
    quizExpectedConcepts: ['cancel', 'zombie', 'leak', 'upstream', 'db', 'disconnect'],
  },
  {
    keywords: ['argo rollouts', 'canary', 'analysis', 'blue-green', 'gitops', 'argocd', 'drift'],
    domain: 'DevOps',
    topic: 'Progressive Delivery (Argo Rollouts Canary + Automated Analysis)',
    explanation:
      'Replace risky big-bang Deployments with Argo Rollouts `canary` strategies shifting weighted traffic (5% -> 25% -> 50% -> 100%) via ALB/Gateway API while an `AnalysisTemplate` continuously queries Prometheus p99 latency & 5xx error budgets. Any metric breach aborts and rolls back automatically in seconds before blast radius widens.',
    codeSnippet: `strategy:
  canary:
    steps:
      - setWeight: 10
      - pause: { duration: 2m }
      - analysis:
          templates: [{ templateName: error-budget-gate }]
      - setWeight: 50`,
    quizQuestion:
      'How does an Argo Rollouts `AnalysisTemplate` bound blast radius better than manual post-deploy smoke tests?',
    quizExpectedConcepts: ['canary', 'weight', 'prometheus', 'rollback', 'automatic', 'blast'],
  },
  {
    keywords: ['aurora', 'global database', 'multi-region', 'rpo', 'rto', 'failover', 'route 53', 'rds proxy'],
    domain: 'AWS',
    topic: 'Multi-Region Active-Active Failover, Aurora Global & RDS Proxy',
    explanation:
      'High-concurrency serverless/Fargate/EKS FastAPI fleets exhaust Postgres `max_connections` during bursts unless pooled through RDS Proxy (or PgBouncer) with IAM DB auth. For sub-minute regional disaster recovery (`RPO < 1s`, `RTO < 1m`), replicate storage asynchronously across regions with Aurora Global Database and steer Route 53 health-checked failover routing.',
    codeSnippet: `# Connect via RDS Proxy endpoint using ephemeral IAM auth token
token = boto3.client("rds").generate_db_auth_token(
    DBHostname=os.environ["RDS_PROXY_HOST"], Port=5432, DBUsername="app_iam_user"
)`,
    quizQuestion:
      'Why does putting RDS Proxy in front of Aurora PostgreSQL prevent outage cascades when 200 EKS pods auto-scale simultaneously during a traffic spike?',
    quizExpectedConcepts: ['connection', 'pool', 'multiplex', 'exhaust', 'failover', 'timeout'],
  },
  {
    keywords: ['spanner', 'truetime', 'bigquery', 'partition', 'clustering', 'exactly-once', 'dead letter'],
    domain: 'GCP',
    topic: 'BigQuery Partitioning/Clustering, Spanner TrueTime & Pub/Sub Exactly-Once',
    explanation:
      'Cut BigQuery scan costs by 90%+ by enforcing `require_partition_filter = true` on `DATE`/`TIMESTAMP` partitioned tables and clustering up to 4 high-cardinality filter columns (`tenant_id`, `service`). For globally strongly consistent multi-region OLTP without lock-manager bottlenecks, Cloud Spanner uses hardware TrueTime clocks for external consistency; on Pub/Sub, remember `exactly-once delivery` applies only within Pub/Sub acknowledgement — your consumer must still remain idempotent!',
    codeSnippet: `CREATE TABLE telemetry.events (
  event_ts TIMESTAMP NOT NULL,
  tenant_id STRING NOT NULL,
  service STRING,
  latency_ms FLOAT64
)
PARTITION BY DATE(event_ts)
CLUSTER BY tenant_id, service
OPTIONS (require_partition_filter = TRUE);`,
    quizQuestion:
      'Why does enabling GCP Pub/Sub Exactly-Once Delivery still NOT eliminate the need for database idempotency keys in your FastAPI consumer?',
    quizExpectedConcepts: ['downstream', 'crash', 'ack', 'commit', 'side effect', 'idempotent'],
  },
];

interface Top1SyllabusBlueprint {
  domain: Domain;
  title: string;
  tier: SkillTier;
  priority: SkillPriority;
  description: string;
  studyBrief: string;
  labPrompt: string;
  reviewCard: {
    prompt: string;
    answer: string;
    explanation: string;
  };
}

const TOP1_SYLLABUS_BLUEPRINTS: Top1SyllabusBlueprint[] = [
  {
    domain: 'Angular',
    title: 'Angular Incremental Hydration & Signal Store Architecture',
    tier: 'Top 1%',
    priority: 'Critical',
    description: 'Eliminate hydration waterfalls with @defer incremental hydration, TransferState, and glitch-free Signal stores.',
    studyBrief:
      'Top 1% Angular architects decouple UI rendering from Zone.js and hydrate below-the-fold subtrees lazily via @defer(hydrate on interaction/viewport) + withEventReplay(). Pair computed() signal selectors with rxMethod/toSignal boundaries so async streams never trigger redundant change-detection passes or stale DOM flashes.',
    labPrompt:
      'Wrap an analytics grid in @defer(hydrate on viewport), configure TransferState HTTP caching, and verify 0 duplicate API calls and <100ms INP in DevTools.',
    reviewCard: {
      prompt: 'What problem does `withEventReplay()` solve during Angular incremental or delayed hydration?',
      answer: 'It captures user clicks/inputs fired before a deferred JS chunk finishes hydrating and replays them once listeners attach.',
      explanation: 'Without event replay, early clicks on SSR-rendered buttons appear broken until hydration completes.',
    },
  },
  {
    domain: 'Angular',
    title: 'Resilient HTTP Interceptors, PKCE Auth & Backpressure',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Full-jitter retry backoff, Idempotency-Key enforcement, exhaustMap submit guards, and OIDC PKCE.',
    studyBrief:
      'Prevent retry storms and double-submissions in production Angular SPAs: restrict retry() to GET/HEAD or Idempotency-Key requests on 502/503/504 with full jitter, use exhaustMap for mutations, and implement Authorization Code + PKCE without exposing client secrets.',
    labPrompt:
      'Implement a functional HttpInterceptor with full-jitter exponential backoff, Idempotency-Key injection on POST mutations, and an exhaustMap submit pipeline.',
    reviewCard: {
      prompt: 'Why must automatic 504 retry interceptors exclude non-idempotent POST requests unless an `Idempotency-Key` is attached?',
      answer: 'The backend may have already committed the first POST before the gateway timed out, causing duplicate mutations or double charges.',
      explanation: 'Idempotency keys let the server deduplicate retried writes safely.',
    },
  },
  {
    domain: 'FastAPI',
    title: 'Asyncio Non-Blocking Discipline & ACID Row Locking',
    tier: 'Top 1%',
    priority: 'Critical',
    description: 'Eliminate event-loop starvation, tune asyncpg/SQLAlchemy pools, and enforce SELECT ... FOR UPDATE invariants.',
    studyBrief:
      'One synchronous CPU loop or blocking SDK call inside `async def` stalls every concurrent coroutine on that Uvicorn worker. Offload blocking work, manage connection pools in `lifespan`, and serialize balance/quota mutations using `(tenant_id, idempotency_key)` + `SELECT ... FOR UPDATE` without holding locks across network I/O.',
    labPrompt:
      'Reproduce a race-condition double-spend under 50 concurrent FastAPI POSTs and fix it using an ACID transaction with `with_for_update()` and an idempotency table.',
    reviewCard: {
      prompt: 'Why must you never call an external S3 or SQS API while holding a PostgreSQL `SELECT ... FOR UPDATE` row lock?',
      answer: 'Slow external network I/O holds the DB row lock open, starving other transactions and exhausting the connection pool.',
      explanation: 'Commit the DB reservation first or use an outbox/state machine before calling external services.',
    },
  },
  {
    domain: 'FastAPI',
    title: 'Zero-Lock Migrations & End-to-End OTel Propagation',
    tier: 'Top 1%',
    priority: 'High',
    description: '3-step zero-downtime Postgres migrations and W3C traceparent correlation across HTTP and async workers.',
    studyBrief:
      'Avoid ACCESS EXCLUSIVE table locks during live deploys by adding nullable columns, backfilling in bounded batches, and validating CHECK constraints with NOT VALID + VALIDATE CONSTRAINT. Propagate W3C traceparent headers into async queues so p99 spikes trace cleanly across services.',
    labPrompt:
      'Execute a zero-lock NOT NULL migration on a 1M-row Postgres table while running concurrent reads/writes, and emit correlated OTel spans across API + worker.',
    reviewCard: {
      prompt: 'What lock level does `ALTER TABLE ... VALIDATE CONSTRAINT` take compared to `SET NOT NULL`?',
      answer: '`SHARE UPDATE EXCLUSIVE`, which allows concurrent SELECT, INSERT, UPDATE, and DELETE traffic without blocking.',
      explanation: 'Adding `CHECK (col IS NOT NULL) NOT VALID` first avoids scanning the whole table under an `ACCESS EXCLUSIVE` lock.',
    },
  },
  {
    domain: 'DevOps',
    title: 'Kubernetes QoS, PodDisruptionBudgets & Zero-Downtime Drains',
    tier: 'Top 1%',
    priority: 'Critical',
    description: 'cgroups v2 memory enforcement, Guaranteed QoS, PDBs, and ALB/Ingress preStop race elimination.',
    studyBrief:
      'Spot interruptions and rolling deploys cause transient 502s when kube-proxy/ALB deregistration lags behind SIGTERM. Pair `startupProbe`, `readinessProbe`, `preStop: sleep 5`, `terminationGracePeriodSeconds`, and `PodDisruptionBudget` with cgroups v2 memory limits to maintain zero dropped requests.',
    labPrompt:
      'Run `kubectl drain` against a live FastAPI Deployment under load and eliminate all 502/connection-reset errors with preStop hooks and PDBs.',
    reviewCard: {
      prompt: 'Why can a rolling update still return 502s even with a `readinessProbe` if `preStop` is missing?',
      answer: 'SIGTERM reaches the container before the Ingress/ALB removes its endpoint IP from target rotation.',
      explanation: 'A `preStop` sleep gives the control plane time to finish endpoint deregistration before the app closes its listening socket.',
    },
  },
  {
    domain: 'DevOps',
    title: 'Supply Chain Security (SLSA, Cosign) & Multi-Burn SLOs',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Keyless OIDC image signing, distroless containers, OPA admission checks, and multi-window error-budget alerts.',
    studyBrief:
      'Enforce verifiable builds with keyless Cosign signatures, SBOM attestations, and Kyverno/OPA admission policies rejecting unsigned images. Replace threshold CPU alerts with multi-window SLO burn-rate PromQL rules tied directly to release freezes.',
    labPrompt:
      'Sign a distroless container via keyless Cosign in CI, enforce signature verification in Kubernetes, and author a 2%-budget-burn multi-window PromQL alert.',
    reviewCard: {
      prompt: 'What distinguishes a symptom-based SLO burn-rate alert from a traditional CPU > 80% alert?',
      answer: 'Burn-rate alerts page only when user-facing availability/latency error budgets are actively depleting at an unsustainable pace.',
      explanation: 'High CPU with healthy latency is efficient utilization, not an outage.',
    },
  },
  {
    domain: 'AWS',
    title: 'IAM Evaluation Chain, SCP Guardrails & PrivateLink Mesh',
    tier: 'Top 1%',
    priority: 'Critical',
    description: 'Multi-account Organizations SCPs, permission boundaries, OIDC federation, Transit Gateway, and PrivateLink.',
    studyBrief:
      'Master AWS authorization math: effective permission is the intersection of Identity Policy, Resource Policy, Permission Boundary, Session Policy, and SCPs. Eliminate NAT egress charges and public internet hops for S3/Secrets/STS via Interface/Gateway VPC Endpoints and Transit Gateway segmentation.',
    labPrompt:
      'Author an AWS Organizations SCP + IAM Permission Boundary blocking privilege escalation and design a zero-NAT PrivateLink topology for EKS.',
    reviewCard: {
      prompt: 'If an IAM Role has `s3:*` in its identity policy AND the bucket policy allows it, what happens if its Permission Boundary omits `s3:PutObject`?',
      answer: '`s3:PutObject` is denied because effective permissions are the intersection of identity policy and permission boundary.',
      explanation: 'Permission boundaries act as a maximum ceiling, never granting permissions on their own.',
    },
  },
  {
    domain: 'AWS',
    title: 'SQS Long Polling, Visibility Heartbeats & EKS Karpenter',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Cost-optimal SQS long polling, async visibility heartbeats, DLQ redrive safety, and Karpenter bin-packing.',
    studyBrief:
      'Configure `WaitTimeSeconds=20`, renew `ChangeMessageVisibility` on an async heartbeat loop for long-running jobs, and isolate poison pills to a DLQ (`maxReceiveCount=3`). On EKS, enable VPC CNI prefix delegation and Karpenter consolidation for sub-minute node right-sizing.',
    labPrompt:
      'Build an async SQS consumer with a 15s visibility heartbeat + DLQ redrive check, and configure a Karpenter NodePool with consolidation.',
    reviewCard: {
      prompt: 'Why is `NumberOfEmptyReceives` normal on a healthy long-polling SQS worker with zero backlog?',
      answer: 'With `WaitTimeSeconds=20`, idle pollers intentionally wait 20 seconds and return empty when no messages arrive.',
      explanation: 'High empty receives with `ApproximateNumberOfMessagesVisible = 0` indicates active, caught-up pollers rather than failure.',
    },
  },
  {
    domain: 'GCP',
    title: 'VPC Service Controls, Shared VPC & Workload Identity Federation',
    tier: 'Top 1%',
    priority: 'Critical',
    description: 'Cryptographic API perimeters preventing exfiltration plus keyless cross-cloud OIDC/AWS STS federation.',
    studyBrief:
      'IAM cannot stop stolen credentials from exfiltrating BigQuery/GCS data into an external project; VPC Service Controls enforce network/context perimeters around Google-managed APIs. Eliminate all exported JSON service account keys using Workload Identity Federation for GKE, GitHub Actions, and AWS.',
    labPrompt:
      'Define a dry-run VPC-SC perimeter around Cloud Storage & BigQuery in a Shared VPC project and bind a GKE KSA via Workload Identity.',
    reviewCard: {
      prompt: 'What threat does GCP VPC Service Controls mitigate that standard IAM role bindings cannot?',
      answer: 'Data exfiltration by a holder of valid IAM credentials copying GCS/BigQuery data to an external unauthorized GCP project.',
      explanation: 'VPC-SC enforces perimeter boundaries around Google-managed API calls.',
    },
  },
  {
    domain: 'GCP',
    title: 'GKE Gateway API, Cloud Armor WAF & Cloud Run Concurrency',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Multi-service L7 traffic management, Cloud Armor rate-limiting, and Cloud Run/Pub/Sub tuning.',
    studyBrief:
      'Use GKE Gateway API for standardized L7 routing and canary traffic splitting behind Global External ALB + Cloud Armor WAF policies. For serverless FastAPI on Cloud Run, tune concurrency vs CPU allocation (disable CPU throttling for async background tasks) and guard Pub/Sub consumers with `ackDeadlineSeconds` + Dead-Letter Topics.',
    labPrompt:
      'Configure a GKE Gateway route with Cloud Armor rate limiting and tune a Cloud Run + Pub/Sub push service with Dead-Letter Topic retry.',
    reviewCard: {
      prompt: 'What happens if a Cloud Run FastAPI service runs async background tasks after returning HTTP 200 when CPU throttling is enabled?',
      answer: 'Cloud Run throttles CPU immediately after the response is sent, stalling or dropping the background task.',
      explanation: 'Either use `--no-cpu-throttling` or offload background work to Cloud Tasks / Pub/Sub.',
    },
  },
  {
    domain: 'Angular',
    title: 'Web Workers, Zoneless Reactivity & Memory-Safe RxJS Lifecycle',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Main-thread offloading via Web Workers, DestroyRef/takeUntilDestroyed invariants, and clean Signal-RxJS bridges.',
    studyBrief:
      'Protect INP (<100ms) under heavy client telemetry by isolating parsing/aggregation inside Web Workers. Pair `takeUntilDestroyed()` with zoneless `signal()` updates so rapid route switches leak zero subscriptions and trigger surgical DOM updates.',
    labPrompt:
      'Move a 50k-row JSON telemetry aggregator into an Angular Web Worker bridged into a `computed()` Signal store and verify zero retained heap growth after 20 route navigations.',
    reviewCard: {
      prompt: 'Why is `takeUntilDestroyed()` preferred over manual `ngOnDestroy` Subject boilerplate in modern Angular?',
      answer: 'It binds subscription teardown directly to `DestroyRef` automatically, preventing forgotten `next()/complete()` memory leaks.',
      explanation: 'Works seamlessly in both components and injectable services tied to view scopes.',
    },
  },
  {
    domain: 'FastAPI',
    title: 'Backpressure, Token-Bucket Rate Limiting & Disconnect-Safe Streaming',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Redis Lua token-bucket limiters, bounded async semaphores, and disconnect-aware StreamingResponse pipelines.',
    studyBrief:
      'Shield Uvicorn workers and Postgres from bursty tenants using atomic Redis Lua token buckets and bounded `asyncio.Semaphore` gates. Always poll `await request.is_disconnected()` inside SSE/NDJSON generators so closed browser tabs stop expensive upstream work instantly.',
    labPrompt:
      'Implement a per-tenant Redis Lua rate limiter dependency and a disconnect-aware NDJSON StreamingResponse endpoint under concurrent ab/k6 load.',
    reviewCard: {
      prompt: 'Why use an atomic Redis Lua script for API token-bucket rate limiting instead of separate GET + SET calls?',
      answer: 'Separate GET and SET calls race under concurrent requests, allowing bursts above the configured limit.',
      explanation: 'Redis executes Lua scripts atomically on a single thread.',
    },
  },
  {
    domain: 'DevOps',
    title: 'Terraform Blast-Radius Layering, OPA Gates & Argo Rollouts Canary',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Layered IaC state boundaries, Rego plan policy verification, and metric-driven progressive canary rollouts.',
    studyBrief:
      'Split Terraform state by blast radius (Org/IAM -> Network -> Cluster -> App) with OPA Conftest checks on `plan.json` before apply. Promote production services with Argo Rollouts weighted steps validated continuously by Prometheus SLO AnalysisTemplates.',
    labPrompt:
      'Create an OPA Rego gate blocking unencrypted storage in `terraform plan -json` and an Argo Rollout canary template auto-aborting on 5xx spikes.',
    reviewCard: {
      prompt: 'Why separate foundation VPC/IAM Terraform state from application deployment Terraform state?',
      answer: 'It isolates blast radius, cuts plan/apply latency, and prevents app CI runs from locking or accidentally mutating core network state.',
      explanation: 'Layered states match organizational ownership and change frequency.',
    },
  },
  {
    domain: 'AWS',
    title: 'DynamoDB Single-Table Design, RDS Proxy & Multi-Region DR',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Composite PK/SK modeling, hot-key salting, RDS Proxy connection multiplexing, and Aurora Global RPO/RTO.',
    studyBrief:
      'Model DynamoDB around exact access patterns with composite keys and sparse GSIs, salting hot partition keys before hitting 1,000 WCU limits. Multiplex bursty EKS/Lambda Postgres connections via RDS Proxy with IAM auth and plan Aurora Global Database failover drills.',
    labPrompt:
      'Design a DynamoDB single-table schema supporting 4 access patterns without Scans, plus an RDS Proxy IAM connection benchmark.',
    reviewCard: {
      prompt: 'When a DynamoDB partition experiences heavy writes to one tenant key, how do you eliminate `ProvisionedThroughputExceededException`?',
      answer: 'Append a bounded random/hash suffix (write sharding / key salting) to distribute writes evenly across partitions.',
      explanation: 'Each DynamoDB physical partition caps at 1,000 WCU and 3,000 RCU.',
    },
  },
  {
    domain: 'GCP',
    title: 'BigQuery Partition/Clustering, Spanner & Pub/Sub Idempotency',
    tier: 'Top 1%',
    priority: 'High',
    description: 'Partition-pruned BigQuery schemas, Spanner external consistency, and end-to-end idempotent Pub/Sub consumers.',
    studyBrief:
      'Enforce `require_partition_filter = TRUE` + clustering in BigQuery to slash scan costs and speed P95 queries. Understand TrueTime external consistency in Cloud Spanner, and pair Pub/Sub `exactly-once` delivery with database idempotency keys so downstream crashes never duplicate side effects.',
    labPrompt:
      'Partition and cluster a BigQuery telemetry table with partition filter enforcement, then benchmark bytes-scanned savings and write an idempotent Pub/Sub consumer.',
    reviewCard: {
      prompt: 'Why does GCP BigQuery `CLUSTER BY tenant_id, service` save money only when paired with `PARTITION BY` or selective filters?',
      answer: 'Clustering sorts data into storage blocks by column values so queries filtering those columns skip irrelevant blocks instead of scanning full partitions.',
      explanation: 'On-demand BigQuery pricing charges strictly by bytes scanned.',
    },
  },
];

interface DomainAuditRow {
  domain: Domain;
  avgMastery: number;
  nodeCount: number;
  top1Count: number;
  top1ReadyCount: number;
  focusMinutes: number;
  readinessScore: number;
  weakestSkill: JarvisSkillContext | null;
}

function buildTop1DomainAudit(
  skills: JarvisSkillContext[],
  domainFocusMinutes?: Record<string, number>
): DomainAuditRow[] {
  return VALID_DOMAINS.map((domain) => {
    const subset = skills.filter(
      (s) => normalizeDomain(s.domain, s.title, domain) === domain
    );
    const avgMastery =
      subset.length > 0
        ? Math.round(subset.reduce((sum, s) => sum + (Number(s.mastery) || 0), 0) / subset.length)
        : 0;
    const top1Nodes = subset.filter((s) => s.tier === 'Top 1%');
    const top1ReadyCount = top1Nodes.filter((s) => (Number(s.mastery) || 0) >= 80).length;
    const focusMinutes = Number(domainFocusMinutes?.[domain] || 0);
    const weakestSkill =
      [...subset].sort((a, b) => (Number(a.mastery) || 0) - (Number(b.mastery) || 0))[0] || null;
    // Readiness weights average mastery (70%) + Top 1% mastery depth (30%)
    const top1DepthRatio = top1Nodes.length > 0 ? (top1ReadyCount / top1Nodes.length) * 100 : 0;
    const readinessScore = Math.round(avgMastery * 0.7 + top1DepthRatio * 0.3);

    return {
      domain,
      avgMastery,
      nodeCount: subset.length,
      top1Count: top1Nodes.length,
      top1ReadyCount,
      focusMinutes,
      readinessScore,
      weakestSkill,
    };
  });
}

function buildTop1SyllabusPlan(params: {
  skills: JarvisSkillContext[];
  domainFocusMinutes?: Record<string, number>;
  activeProject?: JarvisProjectContext | null;
  targetDomain?: Domain;
}) {
  const audit = buildTop1DomainAudit(params.skills, params.domainFocusMinutes);
  const existingTitlesLower = new Set(
    params.skills.map((s) => s.title.trim().toLowerCase())
  );

  // Order domains from lowest readiness (highest urgency) to strongest
  const orderedByGap = [...audit].sort((a, b) => {
    if (params.targetDomain && a.domain === params.targetDomain) return -1;
    if (params.targetDomain && b.domain === params.targetDomain) return 1;
    return a.readinessScore - b.readinessScore || a.focusMinutes - b.focusMinutes;
  });

  const weeklyFocusOrder = orderedByGap.map((r) => r.domain);
  if (params.activeProject?.primaryDomain) {
    const pd = normalizeDomain(params.activeProject.primaryDomain, '', 'AWS');
    const withoutPd = weeklyFocusOrder.filter((d) => d !== pd);
    weeklyFocusOrder.splice(0, weeklyFocusOrder.length, pd, ...withoutPd);
  }

  // Pick missing Top 1% blueprints prioritizing weakest domains (or targetDomain)
  const addTopics: Array<{
    domain: Domain;
    title: string;
    tier: SkillTier;
    priority: SkillPriority;
    description: string;
    studyBrief: string;
    labPrompt: string;
  }> = [];
  const newReviewCards: Array<{
    domain: Domain;
    skillTitle: string;
    prompt: string;
    answer: string;
    explanation: string;
  }> = [];

  const candidateOrder = params.targetDomain
    ? [params.targetDomain, ...weeklyFocusOrder.filter((d) => d !== params.targetDomain)]
    : weeklyFocusOrder;

  for (const dom of candidateOrder) {
    if (addTopics.length >= 4) break;
    const missingForDom = TOP1_SYLLABUS_BLUEPRINTS.filter(
      (bp) => bp.domain === dom && !existingTitlesLower.has(bp.title.toLowerCase())
    );
    for (const bp of missingForDom) {
      if (addTopics.length >= 4) break;
      addTopics.push({
        domain: bp.domain,
        title: bp.title,
        tier: bp.tier,
        priority: bp.priority,
        description: bp.description,
        studyBrief: bp.studyBrief,
        labPrompt: bp.labPrompt,
      });
      existingTitlesLower.add(bp.title.toLowerCase());
      if (newReviewCards.length < 3) {
        newReviewCards.push({
          domain: bp.domain,
          skillTitle: bp.title,
          prompt: bp.reviewCard.prompt,
          answer: bp.reviewCard.answer,
          explanation: bp.reviewCard.explanation,
        });
      }
    }
  }

  // Elevate weakest existing skills across lagging domains toward Top 1% readiness
  const updateTopics: Array<{
    existingTitle: string;
    tier?: SkillTier;
    priority?: SkillPriority;
  }> = [];

  for (const row of orderedByGap.slice(0, 3)) {
    if (row.weakestSkill && row.weakestSkill.mastery < 85) {
      updateTopics.push({
        existingTitle: row.weakestSkill.title,
        tier: row.weakestSkill.tier === 'Foundational' ? 'Senior' : (row.weakestSkill.tier as SkillTier),
        priority: row.readinessScore < 45 ? 'Critical' : 'High',
      });
    }
  }

  const summary = `Restructured 5-domain Top 1% syllabus (${weeklyFocusOrder.join(' → ')}): added ${addTopics.length} Top 1% modules, elevated ${updateTopics.length} lagging nodes, and queued ${newReviewCards.length} active-recall cards.`;

  return {
    audit,
    orderedByGap,
    action: {
      type: 'structure_syllabus' as const,
      summary,
      weeklyFocusOrder,
      addTopics,
      updateTopics,
      newReviewCards,
    },
  };
}

function scoreTextMatch(queryTokens: string[], fullQueryLower: string, candidateText: string): number {
  const lower = candidateText.toLowerCase();
  let score = 0;
  if (fullQueryLower.length >= 4 && lower.includes(fullQueryLower)) {
    score += 14;
  }
  for (const tok of queryTokens) {
    if (lower.includes(tok)) {
      score += tok.length >= 6 ? 4 : 2;
    }
  }
  return score;
}

function findBestKbEntry(text: string): { entry: JarvisKnowledgeEntry; score: number } | null {
  const lower = text.toLowerCase();
  let best: { entry: JarvisKnowledgeEntry; score: number } | null = null;
  for (const entry of JARVIS_TECH_KB) {
    let score = 0;
    for (const kw of entry.keywords) {
      if (lower.includes(kw)) {
        score += kw.length >= 6 ? 9 : 5;
      }
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { entry, score };
    }
  }
  return best;
}

function resolveReferencedQuest(
  msg: string,
  todayQuests: JarvisQuestContext[]
): JarvisQuestContext | null {
  const lower = msg.toLowerCase();
  const numMatch = lower.match(/(?:quest|task|step|#)\s*(\d+)/i);
  if (numMatch) {
    const idx = Number(numMatch[1]) - 1;
    if (idx >= 0 && idx < todayQuests.length) {
      return todayQuests[idx];
    }
  }
  const tokens = lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  let best: { q: JarvisQuestContext; score: number } | null = null;
  for (const q of todayQuests) {
    const s = scoreTextMatch(tokens, lower, `${q.title} ${q.domain} ${q.linkedSkillTitle}`);
    if (s > 0 && (!best || s > best.score)) {
      best = { q, score: s };
    }
  }
  return best && best.score >= 4 ? best.q : todayQuests.find((q) => q.status !== 'completed') || todayQuests[0] || null;
}

function buildJarvisFallbackResponse(params: {
  userMessage: string;
  trigger: 'user_chat' | 'post_upload_brief' | 'proactive_scan';
  currentScreen: {
    activePage: JarvisPage;
    profileDomainFilter?: Domain | 'All';
    selectedSkillTitle?: string | null;
  };
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  activeProject?: JarvisProjectContext | null;
  skills: JarvisSkillContext[];
  todayQuests: JarvisQuestContext[];
  streakDays?: number;
  domainFocusMinutes?: Record<string, number>;
}) {
  const msg = (params.userMessage || '').trim();
  const lower = msg.toLowerCase();
  const history = params.conversationHistory || [];
  const lastAssistantMsg = [...history].reverse().find((m) => m.role === 'assistant')?.content || '';
  const recentHistoryContext = history.slice(-4).map((m) => m.content).join(' ');

  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'this', 'that', 'what', 'how', 'can', 'you',
    'why', 'please', 'tell', 'show', 'open', 'explain', 'walk', 'through',
    'step', 'guide', 'about', 'more', 'give', 'code', 'example', 'help',
  ]);
  const queryTokens = Array.from(
    new Set(lower.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !stopWords.has(t)))
  );

  const pendingQuests = (params.todayQuests || []).filter((q) => q.status !== 'completed');
  const topQuest = pendingQuests[0] || (params.todayQuests || [])[0] || null;

  const sortedSkills = [...(params.skills || [])].sort((a, b) => {
    const pRank = (p: string) => (p === 'Critical' ? 0 : p === 'High' ? 1 : 2);
    const diff = pRank(a.priority) - pRank(b.priority);
    if (diff !== 0) return diff;
    return a.mastery - b.mastery;
  });

  // 1. Post-upload automatic tactical briefing
  if (params.trigger === 'post_upload_brief' && params.activeProject) {
    const mods = params.activeProject.masterSyllabusModules || [];
    const actions: JarvisAction[] = [{ type: 'navigate', page: 'quests' }];
    if (topQuest) {
      actions.push({ type: 'focus_quest', questIdOrTitle: topQuest.id || topQuest.title });
    }

    const stepLines = pendingQuests.slice(0, 3).map((q, idx) => {
      const checklistHint = q.masteryChecklist?.[0] ? ` — Start with: ${q.masteryChecklist[0]}` : '';
      return `${idx + 1}. [${q.rank} · ${q.domain}] ${q.title}${checklistHint}`;
    });

    const firstModule = mods[0];
    const kb = firstModule ? findBestKbEntry(`${firstModule.title} ${firstModule.keyInternals}`) : null;

    return {
      headline: `Mission Brief · ${params.activeProject.projectName}`,
      interactiveMode: 'walkthrough' as JarvisInteractiveMode,
      reply: [
        `Analysis complete for "${params.activeProject.projectName}" (${params.activeProject.rank} · Primary: ${params.activeProject.primaryDomain}). I switched your screen to Quests and locked focus on your #1 priority task.`,
        firstModule
          ? `Critical Module #1: ${firstModule.title}\n• Goal: ${firstModule.objective}\n• Key Internals: ${firstModule.keyInternals}`
          : `Mastery Goal: ${params.activeProject.masteryGoal}`,
        stepLines.length > 0
          ? `Your Ordered Action Plan:\n${stepLines.join('\n')}`
          : 'Inspect your syllabus nodes in Profile to drill internals.',
        `Tell me "Walk me through Quest 1", ask any doubt, or say "Quiz me" to test your readiness.`,
      ].join('\n\n'),
      codeSnippet: kb?.entry.codeSnippet,
      uiActions: actions,
      suggestedFollowUps: [
        topQuest ? `Walk me through "${topQuest.title.slice(0, 36)}"` : 'What should I build first?',
        'Quiz me on this project',
        `Open ${params.activeProject.primaryDomain} syllabus`,
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 2. Interactive Quiz Answer Evaluation (if last JARVIS turn was a quiz challenge and user didn't give a command)
  const wasQuizTurn =
    lastAssistantMsg.includes('Quiz Challenge') || lastAssistantMsg.includes('Answer Question:');
  const isCommandOverride = /\b(go to|switch|open|refresh|complete quest|mark .* done|upload|close drawer|analyze|quiz me|test me)\b/i.test(
    lower
  );

  if (wasQuizTurn && !isCommandOverride && msg.length >= 4) {
    const matchedKb = findBestKbEntry(`${lastAssistantMsg} ${recentHistoryContext}`);
    const expected = matchedKb?.entry.quizExpectedConcepts || ['idempotency', 'lock', 'timeout', 'retry', 'boundary'];
    const hits = expected.filter((kw) => lower.includes(kw));
    const misses = expected.filter((kw) => !lower.includes(kw));

    const verdict =
      hits.length >= 2
        ? `Strong answer! You nailed ${hits.map((h) => `"${h}"`).join(', ')}.`
        : hits.length === 1
        ? `Partially right — good catch on "${hits[0]}", though Staff-level rigor also watches for ${misses.slice(0, 2).join(' and ')}.`
        : `Good attempt — here is the key Staff-level insight you want in mind: ${misses.slice(0, 3).join(', ')}.`;

    const fallbackSkill = matchedKb
      ? sortedSkills.find(
          (s) => normalizeDomain(s.domain, '', 'AWS') === matchedKb.entry.domain
        )
      : sortedSkills[0];

    const actions: JarvisAction[] =
      hits.length >= 2 && fallbackSkill
        ? [
            {
              type: 'award_skill_practice',
              skillTitle: fallbackSkill.title,
              domain: normalizeDomain(fallbackSkill.domain, fallbackSkill.title, 'AWS'),
              masteryBoost: 6,
            },
          ]
        : [];

    return {
      headline: `Quiz Feedback · ${matchedKb?.entry.topic || 'Architecture Check'}`,
      interactiveMode: 'quiz' as JarvisInteractiveMode,
      reply: [
        `### Verdict\n${verdict}${hits.length >= 2 && fallbackSkill ? `\n\n- **Upskill Reward**: Boosted \`${fallbackSkill.title}\` (+6% mastery).` : ''}`,
        matchedKb
          ? `### Reference Mechanism (${matchedKb.entry.domain})\n${matchedKb.entry.explanation}`
          : '### Key Principle\nFocus on the exact concurrency/retry/IAM failure boundary and verify it with telemetry.',
        topQuest
          ? `Ready to mark **${topQuest.title}** complete, or want another Principal scenario question?`
          : 'Want another challenge question or should we inspect your next syllabus topic?',
      ].join('\n\n'),
      codeSnippet: matchedKb?.entry.codeSnippet,
      uiActions: actions,
      suggestedFollowUps: [
        'Quiz me with another question',
        topQuest ? `Complete quest: ${topQuest.title.slice(0, 34)}` : 'Open weakest skill brief',
        'Walk me through Quest 1',
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 3. Priorly or Actively Completed Job Task -> Mark Done & Resume Path
  const isJobTaskDoneIntent =
    /\b(complete|completed|finish|finished|done|mark done|already did|already completed|priorly completed|mark .* done)\b/i.test(
      lower
    ) &&
    (/\b(job|project|mission|work task|resume.*path|normal path|normal routine)\b/i.test(lower) ||
      Boolean(params.activeProject && /\b(project|mission|job)\b/i.test(lower)));

  if (isJobTaskDoneIntent) {
    const mentionedDom = VALID_DOMAINS.find((d) =>
      new RegExp(`\\b${d.toLowerCase()}\\b`, 'i').test(msg)
    );
    const jobDomain: Domain =
      mentionedDom ||
      (params.activeProject?.primaryDomain
        ? normalizeDomain(params.activeProject.primaryDomain, '', 'AWS')
        : 'AWS');

    const extractedNameMatch = msg.match(
      /(?:completed|finished|did|mark)\s+(?:the\s+|my\s+)?(["']?[^"'\n,.]+["']?)\s+(?:job|project|task|mission)/i
    );
    const inferredJobTitle = (
      extractedNameMatch?.[1]?.replace(/["']/g, '').trim() ||
      params.activeProject?.projectName ||
      `${jobDomain} Production Deliverable`
    ).slice(0, 120);

    return {
      headline: `Job Task Marked Done · Resuming ${jobDomain} Path`,
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply: [
        `### Job Completion Recorded\n- **Completed Task**: \`${inferredJobTitle}\` (${jobDomain})\n- **Roadmap & Skill Sync**: Credited experience to your ${jobDomain} mastery nodes and checked off matching roadmap milestones.`,
        `### Normal Path Resumed\n- Exited any project override lock and regenerated your balanced 5-domain learning routine.\n- Switched to **${jobDomain} Roadmap** so you can inspect your updated Domain Level.`,
      ].join('\n\n'),
      uiActions: [
        {
          type: 'mark_job_task_done',
          projectName: inferredJobTitle,
          domain: jobDomain,
          taskSummary: msg.slice(0, 600),
          resumePath: true,
        },
        { type: 'navigate', page: 'roadmaps', domainFilter: jobDomain },
      ],
      suggestedFollowUps: [
        `Coach me on my next ${jobDomain} roadmap step`,
        'Go to Quests',
        `Quiz me on ${jobDomain}`,
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 3b. Direct Quest Completion via Conversation
  if (
    /\b(complete|finish|finished|mark done|done with|check off)\b/i.test(lower) &&
    (/\b(quest|task|this|step|1|2|3|4)\b/i.test(lower) || pendingQuests.length > 0) &&
    !/\bproject\b/i.test(lower)
  ) {
    const targetQuest = resolveReferencedQuest(msg, pendingQuests.length ? pendingQuests : params.todayQuests);
    if (targetQuest && targetQuest.status !== 'completed') {
      const remaining = pendingQuests.filter((q) => q.id !== targetQuest.id);
      const nextQ = remaining[0];
      return {
        headline: `Quest Completed · +${targetQuest.xpReward} XP`,
        interactiveMode: 'mentor' as JarvisInteractiveMode,
        reply: [
          `Marked "${targetQuest.title}" (${targetQuest.domain}) as completed and logged +${targetQuest.xpReward} XP + mastery progress automatically!`,
          nextQ
            ? `Next up on screen: "${nextQ.title}" (${nextQ.rank} · ${nextQ.domain} · ${nextQ.estimatedMinutes}m).\nObjective: ${nextQ.objective}`
            : `All of today's quests are now cleared! Say "Quiz me" for bonus recall or "Open my weakest topic" to keep leveling up.`,
        ].join('\n\n'),
        uiActions: [
          { type: 'navigate', page: 'quests' },
          { type: 'complete_quest', questIdOrTitle: targetQuest.id || targetQuest.title },
          ...(nextQ ? [{ type: 'focus_quest', questIdOrTitle: nextQ.id || nextQ.title } as JarvisAction] : []),
        ],
        suggestedFollowUps: nextQ
          ? [`Walk me through "${nextQ.title.slice(0, 36)}"`, 'Quiz me on this domain']
          : ['Open my weakest skill brief', 'Upload a new project task'],
        aiNotice: AI_QUOTA_NOTICE,
      };
    }
  }

  // 4. Interactive Quiz Trigger
  if (/\b(quiz|test me|ask me|interview|challenge me|recall check)\b/i.test(lower)) {
    const mentionedDomain = VALID_DOMAINS.find((d) =>
      new RegExp(`\\b${d.toLowerCase()}\\b`, 'i').test(msg)
    );
    const contextSeed = `${msg} ${params.currentScreen.selectedSkillTitle || ''} ${topQuest?.title || ''} ${params.activeProject?.masterSyllabusModules?.[0]?.title || ''} ${recentHistoryContext}`;
    const matchedKb =
      (mentionedDomain
        ? JARVIS_TECH_KB.find((e) => e.domain === mentionedDomain)
        : null) ||
      findBestKbEntry(contextSeed)?.entry ||
      JARVIS_TECH_KB[0];

    return {
      headline: `Interactive Quiz · ${matchedKb.domain}`,
      interactiveMode: 'quiz' as JarvisInteractiveMode,
      reply: `Quiz Challenge (${matchedKb.topic}):\n\n${matchedKb.quizQuestion}\n\nReply with your reasoning below and I will grade it against Top 1% invariants.`,
      uiActions: [],
      suggestedFollowUps: [
        'Explain the answer & show code',
        'Walk me through Quest 1',
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 5. Direct Upload via pasted text or upload navigation
  if (msg.length > 260 && (msg.includes('\n') || /\b(lab|module|architecture|fastapi|angular|aws|kubernetes)\b/i.test(lower))) {
    const firstLine = (msg.split('\n')[0] || '').trim();
    const projectMatch = msg.match(/(?:project|title|mission)\s*[:\-]\s*([^\n]{3,80})/i);
    const inferredProjectName = (
      projectMatch?.[1] ||
      firstLine.replace(/^#+\s*/, '').replace(/^\d+[\.\)]\s*/, '')
    )
      .trim()
      .slice(0, 80);

    return {
      headline: 'Loaded Brief into Upload Screen',
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply:
        'I detected a detailed project specification in your message, switched you to the Upload Task screen, and pre-filled the Project Name and Task Brief. Click "Activate Project & Update Syllabus" to compile your modules and Day 1 quests.',
      uiActions: [
        {
          type: 'prefill_upload',
          projectName: inferredProjectName || undefined,
          rawTaskBrief: msg.slice(0, 10000),
        },
      ],
      suggestedFollowUps: ['Analyze my current quests instead', 'Back to Quests'],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 6. Explicit UI commands
  const explicitCmdDomain = VALID_DOMAINS.find((d) =>
    new RegExp(`\\b${d.toLowerCase()}\\b`, 'i').test(msg)
  );

  if (/\b(close|dismiss)\s+(drawer|brief|panel|syllabus)\b/i.test(lower)) {
    return {
      headline: 'Screen Updated · Drawer Closed',
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply: 'Closed the Study Brief drawer so you have a clear view of the workspace.',
      uiActions: [{ type: 'close_skill_drawer' } as JarvisAction],
      suggestedFollowUps: ['Analyze my pending quests', 'Go back to Quests', 'Quiz me'],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  if (/\b(refresh|regenerate|re-issue|new)\s+(daily\s+)?quests?\b/i.test(lower)) {
    return {
      headline: 'Refreshing Daily Quests',
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply:
        'Switched to Quests and re-issued today’s prioritized Daily Quests based on your active project and skill gaps.',
      uiActions: [{ type: 'navigate', page: 'quests' }, { type: 'refresh_quests' }],
      suggestedFollowUps: ['Walk me through Quest 1', 'Open my weakest topic'],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  if (/\b(upload|new project|add project|new task|paste brief)\b/i.test(lower) && !/\buploaded\b/i.test(lower)) {
    return {
      headline: 'Navigated · Upload Project Task',
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply:
        'Opened the Upload Task screen. Paste your deliverable list or upload a file (`.txt`, `.md`, etc.) — or paste the brief right here in chat and I’ll pre-fill it for you.',
      uiActions: [{ type: 'navigate', page: 'upload' }],
      suggestedFollowUps: ['Analyze my current tasks', 'Back to Quests'],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  if (/\b(weakest|lowest|gap|blind ?spot|behind)\b/i.test(lower)) {
    const pool = explicitCmdDomain
      ? sortedSkills.filter((s) => normalizeDomain(s.domain, '', 'AWS') === explicitCmdDomain)
      : sortedSkills;
    const weakest = pool[0] || sortedSkills[0];
    if (weakest) {
      const kb = findBestKbEntry(`${weakest.title} ${weakest.description || ''} ${weakest.studyBrief || ''}`);
      return {
        headline: `Priority Gap · ${weakest.domain} (${weakest.mastery}%)`,
        interactiveMode: 'mentor' as JarvisInteractiveMode,
        reply: [
          `Opened your highest-leverage gap${explicitCmdDomain ? ` in ${explicitCmdDomain}` : ''}: "${weakest.title}" (${weakest.tier} · ${weakest.mastery}% mastery). The Study Brief drawer is open alongside this console.`,
          kb ? `Core Mechanism:\n${kb.entry.explanation}` : weakest.studyBrief?.slice(0, 500) || weakest.description || '',
          weakest.labPrompt ? `Hands-on Lab Target:\n${weakest.labPrompt.slice(0, 380)}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        codeSnippet: kb?.entry.codeSnippet,
        uiActions: [
          {
            type: 'open_skill',
            skillTitle: weakest.title,
            domain: normalizeDomain(weakest.domain, weakest.title, 'AWS'),
          },
        ],
        suggestedFollowUps: [
          `Quiz me on ${weakest.domain}`,
          'Switch back to Quests',
          'Walk me through Quest 1',
        ],
        aiNotice: AI_QUOTA_NOTICE,
      };
    }
  }

  // 7. Walkthrough / Step-by-Step Guide Intent
  const isWalkthrough = /\b(walk ?me ?through|step by step|steps|how do i (solve|start|build|do|execute|implement)|guide me)\b/i.test(
    lower
  );
  if (isWalkthrough) {
    const targetQuest = resolveReferencedQuest(msg, params.todayQuests);
    if (targetQuest) {
      const matchedMod = (params.activeProject?.masterSyllabusModules || []).find((m) =>
        scoreTextMatch(
          targetQuest.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4),
          targetQuest.title.toLowerCase(),
          `${m.title} ${m.objective}`
        ) >= 4
      );
      const matchedSkill = (params.skills || []).find(
        (s) =>
          s.title.toLowerCase() === targetQuest.linkedSkillTitle.toLowerCase() ||
          scoreTextMatch(
            targetQuest.title.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4),
            targetQuest.title.toLowerCase(),
            `${s.title} ${s.description || ''}`
          ) >= 4
      );
      const kb = findBestKbEntry(
        `${targetQuest.title} ${targetQuest.objective} ${matchedMod?.keyInternals || ''} ${matchedSkill?.studyBrief || ''}`
      );

      const checklistLines = (targetQuest.masteryChecklist || []).map((c, i) => `Step ${i + 1}: ${c}`);

      return {
        headline: `Walkthrough · ${targetQuest.title.slice(0, 42)}`,
        interactiveMode: 'walkthrough' as JarvisInteractiveMode,
        reply: [
          `Focused "${targetQuest.title}" (${targetQuest.rank} · ${targetQuest.domain} · ${targetQuest.estimatedMinutes}m) on screen. Here is your concrete execution blueprint:`,
          `Objective: ${targetQuest.objective}`,
          checklistLines.length ? `Execution Steps:\n${checklistLines.join('\n')}` : '',
          matchedMod
            ? `Verification Bar (${matchedMod.title}): ${matchedMod.verificationCriteria}`
            : '',
          kb
            ? `Key Architecture Pattern (${kb.entry.topic}):\n${kb.entry.explanation}`
            : matchedSkill?.studyBrief?.slice(0, 450) || '',
          `Ask me a doubt about any step above, or tell me "Complete quest" when you finish!`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        codeSnippet: kb?.entry.codeSnippet,
        uiActions: [
          { type: 'navigate', page: 'quests' },
          { type: 'focus_quest', questIdOrTitle: targetQuest.id || targetQuest.title },
        ],
        suggestedFollowUps: [
          `Complete "${targetQuest.title.slice(0, 34)}"`,
          `Quiz me on ${targetQuest.domain}`,
          'Show code & failure modes',
        ],
        aiNotice: AI_QUOTA_NOTICE,
      };
    }
  }

  // 8. Proactive scan / status / "what should I do next"
  const isAnalyzeIntent =
    params.trigger === 'proactive_scan' ||
    /\b(analyze|analysis|what should i do|what next|next step|prioritize|brief me|my tasks?|daily plan|status|routine)\b/i.test(
      lower
    );

  if (isAnalyzeIntent) {
    const actions: JarvisAction[] = [{ type: 'navigate', page: 'quests' }];
    if (topQuest) {
      actions.push({ type: 'focus_quest', questIdOrTitle: topQuest.id || topQuest.title });
    }

    const doneCount = (params.todayQuests || []).length - pendingQuests.length;
    const weakestOverall = sortedSkills[0];
    const kb = topQuest ? findBestKbEntry(`${topQuest.title} ${topQuest.objective}`) : null;

    const lines: string[] = [];
    if (params.activeProject) {
      lines.push(
        `Active Project Priority: "${params.activeProject.projectName}" (${params.activeProject.rank} · ${params.activeProject.primaryDomain}).`
      );
    } else {
      lines.push(
        `Balanced Routine Active (${params.streakDays ?? 1}d streak · No active project override).`
      );
    }

    if (pendingQuests.length > 0 && topQuest) {
      lines.push(
        `${pendingQuests.length} pending quest(s) remaining (${doneCount} cleared). I switched focus onto Quest #1: "${topQuest.title}" (${topQuest.domain} · ${topQuest.estimatedMinutes}m · +${topQuest.xpReward} XP).`
      );
      lines.push(
        `What to do right now:\n${(topQuest.masteryChecklist || [topQuest.objective])
          .map((c, i) => `${i + 1}. ${c}`)
          .join('\n')}`
      );
    } else {
      lines.push(
        'All quests for today are completed!' +
          (weakestOverall
            ? ` Opening your weakest high-leverage topic next: "${weakestOverall.title}" (${weakestOverall.domain} · ${weakestOverall.mastery}%).`
            : ' Upload a new project brief whenever ready.')
      );
      if (weakestOverall) {
        actions.length = 0;
        actions.push({
          type: 'open_skill',
          skillTitle: weakestOverall.title,
          domain: normalizeDomain(weakestOverall.domain, weakestOverall.title, 'AWS'),
        });
      }
    }

    return {
      headline: topQuest ? `Mission Focus · ${topQuest.domain}` : 'Daily Sweep Complete',
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply: lines.join('\n\n'),
      codeSnippet: kb?.entry.codeSnippet,
      uiActions: actions,
      suggestedFollowUps: [
        topQuest ? `Walk me through "${topQuest.title.slice(0, 34)}"` : 'Upload a new project task',
        `Quiz me on ${topQuest?.domain || 'AWS'}`,
        'Open my weakest topic brief',
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 8.5 JARVIS Domain Roadmap Designer & Navigation
  const mentionedDomain = VALID_DOMAINS.find((d) =>
    new RegExp(`\\b${d.toLowerCase()}\\b`, 'i').test(msg)
  );

  if (/\b(roadmap|roadmaps|learning path)\b/i.test(lower)) {
    const wantsAll = /\b(all|every|each|5)\b/i.test(lower) || !mentionedDomain;
    const isDesignCmd = /\b(design|create|build|architect|generate|make|upgrade|update|redesign)\b/i.test(
      lower
    );

    if (isDesignCmd) {
      const targetDom: Domain | 'All' = wantsAll ? 'All' : mentionedDomain!;
      const displayDom = targetDom === 'All' ? 'Angular' : targetDom;
      return {
        headline: `JARVIS Roadmap Architect · ${targetDom === 'All' ? 'All 5 Domains' : targetDom}`,
        interactiveMode: 'mentor' as JarvisInteractiveMode,
        reply: [
          `### Roadmap Architecture Dispatched\n- Designing a 4-stage progression (**Foundational → Senior → Staff → Top 1% Principal**) for **${targetDom === 'All' ? 'Angular, FastAPI, DevOps, AWS, and GCP' : targetDom}**.\n- Opened **Roadmaps (${displayDom})** so you can track your Domain Level, check off prior completed milestones, and launch labs.`,
        ].join('\n\n'),
        uiActions: [
          { type: 'design_roadmap', domain: targetDom, focusGoal: msg.slice(0, 200) },
          { type: 'navigate', page: 'roadmaps', domainFilter: displayDom },
        ],
        suggestedFollowUps: [
          `Mark a prior ${displayDom} job task done`,
          `Quiz me on ${displayDom}`,
          'Go to Quests',
        ],
        aiNotice: AI_QUOTA_NOTICE,
      };
    }

    const navDom = mentionedDomain || 'Angular';
    return {
      headline: `Navigated · ${mentionedDomain ? `${mentionedDomain} ` : ''}Roadmaps`,
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply: `Opened **Domain Roadmaps (${navDom})** where your level, stage completion, and prior job task tracking live. Want me to redesign or upgrade ${mentionedDomain || 'all 5'} roadmaps?`,
      uiActions: [{ type: 'navigate', page: 'roadmaps', domainFilter: navDom }],
      suggestedFollowUps: [
        `Design ${navDom} roadmap`,
        'Design roadmaps for all 5 domains',
        `Quiz me on ${navDom}`,
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 8.6 Top 1% Syllabus Structuring
  const isStructureIntent =
    /\b(structure|restructure|upgrade|optimize|rebalance|top\s*1\s*%|top 1 percent|make me top|all domains?|improve.*domains?|audit.*domains?)\b/i.test(
      lower
    ) ||
    (/\b(syllabus|curriculum)\b/i.test(lower) &&
      /\b(build|create|update|plan|fix|improve|focus|for|my)\b/i.test(lower));

  if (isStructureIntent) {
    const plan = buildTop1SyllabusPlan({
      skills: params.skills || [],
      domainFocusMinutes: params.domainFocusMinutes,
      activeProject: params.activeProject,
      targetDomain: mentionedDomain,
    });
    const weakestDomain = plan.orderedByGap[0];
    const targetSkill =
      (mentionedDomain
        ? sortedSkills.find((s) => normalizeDomain(s.domain, '', 'AWS') === mentionedDomain)
        : weakestDomain?.weakestSkill) || sortedSkills[0];

    const auditLines = plan.audit
      .map(
        (r) =>
          `• ${r.domain}: ${r.avgMastery}% avg (${r.top1ReadyCount}/${r.top1Count} Top 1% ready · ${r.focusMinutes}m focus)`
      )
      .join('\n');

    const addedLines = plan.action.addTopics.length
      ? `New Top 1% Modules Added:\n${plan.action.addTopics
          .map((t) => `• [${t.domain}] ${t.title}`)
          .join('\n')}`
      : 'All core Top 1% blueprint modules are already in your matrix; elevated your weakest lagging nodes to Critical/High priority.';

    const actions: JarvisAction[] = [plan.action];
    if (targetSkill) {
      actions.push({
        type: 'open_skill',
        skillTitle: targetSkill.title,
        domain: normalizeDomain(targetSkill.domain, targetSkill.title, 'AWS'),
      });
    } else {
      actions.push({ type: 'navigate', page: 'profile', domainFilter: mentionedDomain || 'All' });
    }

    const kb = targetSkill
      ? findBestKbEntry(`${targetSkill.title} ${targetSkill.description || ''}`)
      : null;

    return {
      headline: `Top 1% Syllabus Structured · ${plan.orderedByGap[0]?.domain || '5 Domains'} Priority`,
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply: [
        `I audited your 5-domain readiness toward Top 1% mastery and restructured your syllabus + Mon–Fri rotation (${plan.action.weeklyFocusOrder.join(' → ')}):`,
        `5-Domain Telemetry:\n${auditLines}`,
        addedLines,
        targetSkill
          ? `Opened your #1 bottleneck brief ("${targetSkill.title}" · ${targetSkill.domain} · ${targetSkill.mastery}%) side-by-side. Ready to drill its internals or take a Staff-level quiz?`
          : 'Switched to Profile so you can review your updated 5-domain matrix.',
      ].join('\n\n'),
      codeSnippet: kb?.entry.codeSnippet,
      uiActions: actions,
      suggestedFollowUps: [
        `Quiz me on ${weakestDomain?.domain || 'GCP'}`,
        'Refresh daily quests for this syllabus',
        'Walk me through Quest 1',
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 9. Explicit Profile / Quests Navigation
  if (
    /\b(profile|milestone|progress|streak|rotation|syllabus|topics)\b/i.test(lower) &&
    !/\b(how|why|what is|explain|difference|debug|error|doubt)\b/i.test(lower)
  ) {
    return {
      headline: `Navigated · Profile${mentionedDomain ? ` (${mentionedDomain})` : ''}`,
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply: `Switched your screen to Profile${mentionedDomain ? ` (${mentionedDomain})` : ''}. Pick any syllabus node to open its brief side-by-side, or tell me "Structure my 5-domain syllabus for Top 1% mastery".`,
      uiActions: [
        { type: 'navigate', page: 'profile', domainFilter: mentionedDomain || 'All' },
      ],
      suggestedFollowUps: [
        'Structure my 5-domain syllabus for Top 1% mastery',
        `Open weakest ${mentionedDomain || ''} topic`.trim(),
        'Quiz me',
      ],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  if (/\b(go to quests?|back to quests?|show quests?|daily tasks?)\b/i.test(lower)) {
    const actions: JarvisAction[] = [{ type: 'navigate', page: 'quests' }];
    if (topQuest) actions.push({ type: 'focus_quest', questIdOrTitle: topQuest.id || topQuest.title });
    return {
      headline: 'Navigated · Daily Quests',
      interactiveMode: 'mentor' as JarvisInteractiveMode,
      reply: topQuest
        ? `Returned to Quests and highlighted "${topQuest.title}" (${topQuest.domain} · +${topQuest.xpReward} XP).`
        : 'Returned to your Quests screen.',
      uiActions: actions,
      suggestedFollowUps: ['Walk me through Quest 1', 'Quiz me'],
      aiNotice: AI_QUOTA_NOTICE,
    };
  }

  // 10. Context-Aware Follow-up & Technical Doubt Solver
  const isShortFollowUp =
    queryTokens.length <= 2 &&
    /\b(why|how|example|code|more|detail|elaborate|next|explain|pitfall|failure)\b/i.test(lower);

  const effectiveSearchQuery = isShortFollowUp
    ? `${msg} ${params.currentScreen.selectedSkillTitle || ''} ${recentHistoryContext} ${topQuest?.title || ''}`
    : msg;

  const effectiveTokens = Array.from(
    new Set(
      effectiveSearchQuery
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 3 && !stopWords.has(t))
    )
  );

  let bestSkill: { item: JarvisSkillContext; score: number } | null = null;
  for (const s of params.skills || []) {
    const score = scoreTextMatch(
      effectiveTokens,
      effectiveSearchQuery.toLowerCase(),
      `${s.title} ${s.domain} ${s.description || ''} ${s.studyBrief || ''} ${s.labPrompt || ''}`
    );
    if (!bestSkill || score > bestSkill.score) {
      bestSkill = { item: s, score };
    }
  }

  let bestModule: {
    item: JarvisProjectContext['masterSyllabusModules'][number];
    score: number;
  } | null = null;
  for (const m of params.activeProject?.masterSyllabusModules || []) {
    const score = scoreTextMatch(
      effectiveTokens,
      effectiveSearchQuery.toLowerCase(),
      `${m.title} ${m.domain} ${m.objective} ${m.keyInternals} ${m.verificationCriteria}`
    );
    if (!bestModule || score > bestModule.score) {
      bestModule = { item: m, score };
    }
  }

  const bestKb = findBestKbEntry(effectiveSearchQuery);
  const actions: JarvisAction[] = [];
  const sections: string[] = [];
  let headline = 'JARVIS Technical Mentor';
  let codeSnippet: string | undefined;

  if (bestKb) {
    headline = `Doubt Resolved · ${bestKb.entry.topic}`;
    sections.push(`${bestKb.entry.topic} (${bestKb.entry.domain}):\n${bestKb.entry.explanation}`);
    codeSnippet = bestKb.entry.codeSnippet;
  }

  if (bestModule && bestModule.score >= 4) {
    if (!bestKb) headline = `Project Module · ${bestModule.item.title}`;
    sections.push(
      `Project Context (${params.activeProject?.projectName} — ${bestModule.item.title}):\n• Goal: ${bestModule.item.objective}\n• Key Internals: ${bestModule.item.keyInternals}\n• Verification: ${bestModule.item.verificationCriteria}`
    );
  }

  if (bestSkill && bestSkill.score >= 4) {
    const matchedDomain = normalizeDomain(bestSkill.item.domain, bestSkill.item.title, 'AWS');
    actions.push({ type: 'open_skill', skillTitle: bestSkill.item.title, domain: matchedDomain });
    if (!bestKb) headline = `Brief Opened · ${bestSkill.item.title}`;
    if (bestSkill.item.studyBrief) {
      sections.push(
        `Opened Study Brief Side-by-Side (${bestSkill.item.title} · ${bestSkill.item.mastery}%):\n${bestSkill.item.studyBrief.slice(0, 550)}`
      );
    }
    if (bestSkill.item.labPrompt) {
      sections.push(`Hands-on Lab:\n${bestSkill.item.labPrompt.slice(0, 350)}`);
    }
  }

  if (sections.length === 0) {
    const targetDomain = mentionedDomain || (params.activeProject?.primaryDomain as Domain) || 'AWS';
    const domainKb = JARVIS_TECH_KB.find((e) => e.domain === targetDomain) || JARVIS_TECH_KB[0];
    const domainSkill = sortedSkills.find(
      (s) => normalizeDomain(s.domain, '', 'AWS') === targetDomain
    );
    if (domainSkill) {
      actions.push({ type: 'open_skill', skillTitle: domainSkill.title, domain: targetDomain });
    }
    headline = `Guidance · ${targetDomain} Architecture`;
    sections.push(
      `Let's tackle "${msg}" concretely in ${targetDomain}. I opened "${domainSkill?.title || targetDomain}" on screen so you can follow along.`
    );
    sections.push(`Key Reference (${domainKb.topic}):\n${domainKb.explanation}`);
    codeSnippet = domainKb.codeSnippet;
  }

  return {
    headline,
    interactiveMode: 'mentor' as JarvisInteractiveMode,
    reply: sections.join('\n\n'),
    codeSnippet,
    uiActions: actions,
    suggestedFollowUps: [
      `Quiz me on ${bestKb?.entry.domain || mentionedDomain || topQuest?.domain || 'AWS'}`,
      topQuest ? `Walk me through "${topQuest.title.slice(0, 34)}"` : 'Analyze my tasks',
      'What should I do next?',
    ],
    aiNotice: AI_QUOTA_NOTICE,
  };
}

interface DomainRoadmapBlueprint {
  visionSummary: string;
  stages: Array<{
    stageNumber: number;
    title: string;
    targetTier: SkillTier;
    milestoneGoal: string;
    steps: Array<{
      id: string;
      title: string;
      skillTitle: string;
      description: string;
      detailedGuide?: string;
      keyPitfalls?: string[];
      deliverables: string[];
      labObjective: string;
    }>;
  }>;
}

const DOMAIN_ROADMAP_BLUEPRINTS: Record<Domain, DomainRoadmapBlueprint> = {
  Angular: {
    visionSummary:
      'Evolve from standalone component building to Top 1% Zoneless, Signal-reactive, Incremental-Hydration frontend architecture with <100ms INP and resilient OIDC/SSE pipelines.',
    stages: [
      {
        stageNumber: 1,
        title: 'Foundational Core & Standalone Patterns',
        targetTier: 'Foundational',
        milestoneGoal: 'Ship clean modular standalone apps with strict typing and functional DI.',
        steps: [
          {
            id: 'ng-1-1',
            title: 'Standalone Architecture & Typed Reactive Forms',
            skillTitle: 'Standalone Architecture & Typed Reactive Forms',
            description: 'Enforce strict route-level lazy chunks, functional guards, and NonNullableFormBuilder.',
            deliverables: ['Lazy feature routes', 'Functional AuthGuard', 'Custom async validator'],
            labObjective: 'Build a multi-step typed form guarded by functional inject() auth checks.',
          },
          {
            id: 'ng-1-2',
            title: 'Modern Template Control Flow & @defer Basics',
            skillTitle: 'Standalone Architecture & Typed Reactive Forms',
            description: 'Replace structural directives with @if/@for track expressions and deferred viewport blocks.',
            deliverables: ['@for trackBy audit', '@defer placeholder UX'],
            labObjective: 'Eliminate DOM thrashing on a 500-row table using track keys and @defer.',
          },
          {
            id: 'ng-1-3',
            title: 'OIDC PKCE & Functional Bearer Interceptor',
            skillTitle: 'Resilient HTTP Interceptors, PKCE Auth & Backpressure',
            description: 'Configure short-lived access tokens and seamless refresh coordination in Angular.',
            deliverables: ['PKCE login flow', 'Single-flight token refresh'],
            labObjective: 'Prevent parallel 401 refresh storms using a shared ReplaySubject lock.',
          },
        ],
      },
      {
        stageNumber: 2,
        title: 'Senior Reactive Systems & Backpressure',
        targetTier: 'Senior',
        milestoneGoal: 'Control async streams and eliminate race conditions or duplicate mutations.',
        steps: [
          {
            id: 'ng-2-1',
            title: 'RxJS Flattening & Backpressure Mastery',
            skillTitle: 'RxJS Flattening & Backpressure Patterns',
            description: 'Deploy switchMap, exhaustMap, concatMap, and takeUntilDestroyed deterministically.',
            deliverables: ['exhaustMap double-submit guard', 'Zero leaked subscriptions'],
            labObjective: 'Verify optimistic search + mutation queue with inner catchError isolation.',
          },
          {
            id: 'ng-2-2',
            title: 'Full-Jitter Retry Interceptors & Idempotency',
            skillTitle: 'Resilient HTTP Interceptors, PKCE Auth & Backpressure',
            description: 'Retry only idempotent reads/Idempotency-Key mutations with full jitter.',
            deliverables: ['Full-jitter delay operator', 'Idempotency-Key header middleware'],
            labObjective: 'Simulate 503/504 ALB blips and confirm zero duplicate POST side effects.',
          },
          {
            id: 'ng-2-3',
            title: 'Real-Time SSE + Adaptive Polling Degradation',
            skillTitle: 'RxJS Flattening & Backpressure Patterns',
            description: 'Handle 22-stage live telemetry streams with Last-Event-ID and graceful fallback.',
            deliverables: ['EventSource signal bridge', '2s->5s->15s polling fallback'],
            labObjective: 'Drop SSE connection mid-stream and verify lossless catch-up via Last-Event-ID.',
          },
        ],
      },
      {
        stageNumber: 3,
        title: 'Staff Signals & Zoneless Architecture',
        targetTier: 'Top 1%',
        milestoneGoal: 'Remove Zone.js overhead and achieve surgical DOM updates under heavy telemetry.',
        steps: [
          {
            id: 'ng-3-1',
            title: 'Signals & Zone-less Change Detection',
            skillTitle: 'Signals & Zone-less Change Detection',
            description: 'Master glitch-free topological Signal graphs and provideZonelessChangeDetection().',
            deliverables: ['Zone-less bootstrap', 'computed() selector graph'],
            labObjective: 'Migrate BehaviorSubject dashboard to Signals and profile DevTools cycles.',
          },
          {
            id: 'ng-3-2',
            title: 'Web Workers for Heavy Client Telemetry',
            skillTitle: 'Web Workers, Zoneless Reactivity & Memory-Safe RxJS Lifecycle',
            description: 'Offload 50k-row aggregation off the main thread to maintain <100ms INP.',
            deliverables: ['Typed Worker bridge', '0 heap leak on route teardown'],
            labObjective: 'Aggregate 50k JSON telemetry rows in a Web Worker into a Signal store.',
          },
          {
            id: 'ng-3-3',
            title: 'Signal/RxJS Interop Boundaries (toSignal / rxMethod)',
            skillTitle: 'Angular Incremental Hydration & Signal Store Architecture',
            description: 'Bridge event streams and synchronous UI state cleanly without NG0600 errors.',
            deliverables: ['untracked() audit', 'Clean error-signal pattern'],
            labObjective: 'Eliminate effect() signal write loops across a multi-filter data grid.',
          },
        ],
      },
      {
        stageNumber: 4,
        title: 'Top 1% Principal Performance & Hydration',
        targetTier: 'Top 1%',
        milestoneGoal: 'Deliver instant SSR interactive TTI/INP at global CDN scale.',
        steps: [
          {
            id: 'ng-4-1',
            title: 'SSR Incremental Hydration & Event Replay',
            skillTitle: 'SSR, Event Replay & Incremental Hydration',
            description: 'Pair @defer(hydrate on viewport) with withEventReplay() and TransferState.',
            deliverables: ['0 duplicate SSR->CSR API calls', 'Event replay verified'],
            labObjective: 'Click an unhydrated control during throttle and confirm event replay execution.',
          },
          {
            id: 'ng-4-2',
            title: 'Direct-to-S3 Multipart Client Coordinator',
            skillTitle: 'Angular Incremental Hydration & Signal Store Architecture',
            description: 'Build semaphore-capped 5MB File.slice chunk uploaders with ETag checksum tracking.',
            deliverables: ['4-concurrent PUT semaphore', 'AbortController cleanup'],
            labObjective: 'Upload a multi-part payload resiliently with pause/resume recovery.',
          },
          {
            id: 'ng-4-3',
            title: 'Frontend Observability & Core Web Vitals Budgets',
            skillTitle: 'Web Workers, Zoneless Reactivity & Memory-Safe RxJS Lifecycle',
            description: 'Instrument LCP/INP/CLS RUM spans and enforce strict bundle size gates in CI.',
            deliverables: ['INP < 100ms telemetry', 'Bundle budget CI fail gate'],
            labObjective: 'Capture client Web Vitals linked to backend OTel trace IDs.',
          },
        ],
      },
    ],
  },
  FastAPI: {
    visionSummary:
      'Progress from typed Pydantic CRUD to Top 1% non-blocking asyncio architecture, ACID concurrency control, zero-lock migrations, and zero-copy analytics engines.',
    stages: [
      {
        stageNumber: 1,
        title: 'Foundational Core & Validation Contracts',
        targetTier: 'Foundational',
        milestoneGoal: 'Design strict, fast, PII-safe API schemas using Pydantic v2.',
        steps: [
          {
            id: 'fa-1-1',
            title: 'Pydantic v2 Validation & Discriminated Unions',
            skillTitle: 'Pydantic v2 Validation Internals & Serialization',
            description: 'Leverage pydantic-core Rust validation and explicit response_model boundaries.',
            deliverables: ['Polymorphic webhook schema', 'ORM output stripping'],
            labObjective: 'Build a webhook router handling 3 event types via discriminated unions.',
          },
          {
            id: 'fa-1-2',
            title: 'Hexagonal Service Layer & Yield Dependencies',
            skillTitle: 'Dependency Injection Lifecycles & Auth Boundaries',
            description: 'Isolate HTTP transport from domain services with deterministic pytest Depends() overrides.',
            deliverables: ['Session rollback on exception', 'Repository DI test suite'],
            labObjective: 'Write integration tests overriding DB/S3 dependencies without network calls.',
          },
          {
            id: 'fa-1-3',
            title: 'Lifespan Connection Pool Management',
            skillTitle: 'Asyncio Event Loop & Connection Pool Tuning',
            description: 'Bind asyncpg, httpx.AsyncClient, and boto3 clients inside @asynccontextmanager lifespan.',
            deliverables: ['Shared app.state clients', 'Clean SIGTERM pool drain'],
            labObjective: 'Measure socket reuse improvement moving per-request clients into lifespan.',
          },
        ],
      },
      {
        stageNumber: 2,
        title: 'Senior Concurrency & Multi-Tenant Security',
        targetTier: 'Senior',
        milestoneGoal: 'Harden auth isolation and keep the Uvicorn event loop responsive.',
        steps: [
          {
            id: 'fa-2-1',
            title: 'Multi-Tenant RBAC Dependencies & Query Isolation',
            skillTitle: 'Dependency Injection Lifecycles & Auth Boundaries',
            description: 'Chain JWT verification, tenant lookup, and role closures with DB-level isolation.',
            deliverables: ['require_role() factory', 'Tenant boundary integration tests'],
            labObjective: 'Verify cross-tenant access attempts fail 403/404 across all endpoints.',
          },
          {
            id: 'fa-2-2',
            title: 'Event-Loop Starvation Audit & Worker Sizing',
            skillTitle: 'Asyncio Event Loop & Connection Pool Tuning',
            description: 'Detect blocking sync I/O inside async def and tune worker/pool math cleanly.',
            deliverables: ['py-spy flamegraph fix', 'DB max_connections math'],
            labObjective: 'Sustain 500 concurrent requests while offloading heavy sync work cleanly.',
          },
          {
            id: 'fa-2-3',
            title: 'Disconnect-Aware SSE Streaming Pipelines',
            skillTitle: 'Backpressure, Token-Bucket Rate Limiting & Disconnect-Safe Streaming',
            description: 'Stream live progress updates with keepalives and request.is_disconnected() abort.',
            deliverables: ['15s SSE keepalive comment', 'Immediate orphan task cancel'],
            labObjective: 'Abort client SSE mid-stream and confirm upstream generator stops cleanly.',
          },
        ],
      },
      {
        stageNumber: 3,
        title: 'Staff Data Integrity & Backpressure',
        targetTier: 'Top 1%',
        milestoneGoal: 'Prevent race conditions, lock outages, and noisy-neighbor traffic bursts.',
        steps: [
          {
            id: 'fa-3-1',
            title: 'ACID Row Locking (SELECT ... FOR UPDATE) & Idempotency',
            skillTitle: 'Asyncio Non-Blocking Discipline & ACID Row Locking',
            description: 'Serialize credit/quota deductions safely without holding locks across HTTP/S3 calls.',
            deliverables: ['Idempotency record table', 'Zero double-spend under concurrency'],
            labObjective: 'Fire 50 parallel deduction requests and assert exact ledger balance.',
          },
          {
            id: 'fa-3-2',
            title: 'Zero-Lock 3-Step PostgreSQL Migrations',
            skillTitle: 'Zero-Lock Migrations & End-to-End OTel Propagation',
            description: 'Add constraints via NOT VALID -> batched backfill -> VALIDATE CONSTRAINT.',
            deliverables: ['Zero ACCESS EXCLUSIVE locks', 'Rollback-safe Alembic script'],
            labObjective: 'Migrate a 1M-row table live without blocking concurrent writes.',
          },
          {
            id: 'fa-3-3',
            title: 'Atomic Redis Lua Token-Bucket Rate Limiting',
            skillTitle: 'Backpressure, Token-Bucket Rate Limiting & Disconnect-Safe Streaming',
            description: 'Implement burst-tolerant per-tenant rate limiters and Retry-After headers.',
            deliverables: ['Atomic Lua script', '429 Retry-After contract'],
            labObjective: 'Burst 200 concurrent calls and confirm exact token-bucket enforcement.',
          },
        ],
      },
      {
        stageNumber: 4,
        title: 'Top 1% Principal Distributed Systems',
        targetTier: 'Top 1%',
        milestoneGoal: 'Trace async cloud pipelines end-to-end and process GB-scale data in tight RAM.',
        steps: [
          {
            id: 'fa-4-1',
            title: 'End-to-End OpenTelemetry traceparent Propagation',
            skillTitle: 'OpenTelemetry Tracing & Structured Observability',
            description: 'Inject/extract W3C traceparent across FastAPI, Redis/SQS queues, and SQLAlchemy.',
            deliverables: ['Unified HTTP->Worker trace', 'Tail-sampled p99 slow SQL'],
            labObjective: 'Trace an HTTP POST across SQS into a Python consumer in one flamegraph.',
          },
          {
            id: 'fa-4-2',
            title: 'Zero-Copy S3 Profiling Under 512MB RAM (DuckDB + PyArrow)',
            skillTitle: 'Asyncio Non-Blocking Discipline & ACID Row Locking',
            description: 'Stream Parquet byte-ranges directly from S3 with bounded memory_limit and threads.',
            deliverables: ['httpfs range-read query', 'approx_quantile + cardinality'],
            labObjective: 'Profile a large S3 Parquet dataset inside a strict 512MB container.',
          },
          {
            id: 'fa-4-3',
            title: 'Outbox Pattern & Poison-Pill Recovery',
            skillTitle: 'Zero-Lock Migrations & End-to-End OTel Propagation',
            description: 'Guarantee atomic DB state + event publishing using transactional outbox tables.',
            deliverables: ['Outbox relay worker', 'Idempotent replay guarantee'],
            labObjective: 'Kill process between DB commit and queue send; verify outbox recovery.',
          },
        ],
      },
    ],
  },
  DevOps: {
    visionSummary:
      'Advance from CI pipelines to Top 1% Kubernetes QoS scheduling, blast-radius Terraform layering, metric-gated GitOps delivery, and verifiable SLSA supply chains.',
    stages: [
      {
        stageNumber: 1,
        title: 'Foundational Containers & SLO Discipline',
        targetTier: 'Foundational',
        milestoneGoal: 'Ship minimal containers and replace noisy infra alerts with error budgets.',
        steps: [
          {
            id: 'do-1-1',
            title: 'Multi-Stage Distroless Images & Non-Root Security',
            skillTitle: 'GitOps Progressive Delivery & Supply Chain Security',
            description: 'Cut image CVEs and cold-start size using distroless bases and pinned digests.',
            deliverables: ['Non-root UID container', 'Digest-pinned base images'],
            labObjective: 'Shrink a Python service image >70% and pass zero-high-CVE scan.',
          },
          {
            id: 'do-1-2',
            title: 'SLO Error Budgets & Multi-Burn-Rate Alerting',
            skillTitle: 'SLO Error Budgets & Multi-Burn-Rate Alerting',
            description: 'Author fast/slow burn-rate PromQL alerts tied directly to availability SLIs.',
            deliverables: ['99.9% SLO burn-rate rules', 'Freeze policy runbook'],
            labObjective: 'Simulate 1% 5xx traffic and verify burn-rate alert fires within target window.',
          },
          {
            id: 'do-1-3',
            title: 'Container Readiness, Liveness & Startup Probe Separation',
            skillTitle: 'Kubernetes QoS, PodDisruptionBudgets & Zero-Downtime Drains',
            description: 'Avoid crash-loops during slow migrations by decoupling startup vs readiness checks.',
            deliverables: ['/healthz vs /readyz split', 'Zero cascade restarts'],
            labObjective: 'Inject downstream dependency loss and confirm traffic drains without pod restart.',
          },
        ],
      },
      {
        stageNumber: 2,
        title: 'Senior IaC Architecture & Autoscaling',
        targetTier: 'Senior',
        milestoneGoal: 'Isolate Terraform blast radius and autoscale workers ahead of queue latency.',
        steps: [
          {
            id: 'do-2-1',
            title: 'Terraform Blast-Radius State Layering & Remote Locks',
            skillTitle: 'Terraform State Architecture & Drift Governance',
            description: 'Separate Org/IAM, VPC, Cluster, and App states cleanly with remote locking.',
            deliverables: ['Layered state topology', 'Drift detection workflow'],
            labObjective: 'Refactor monolithic Terraform config into 3 independent blast-radius layers.',
          },
          {
            id: 'do-2-2',
            title: 'OPA / Conftest Policy-as-Code Gates on Terraform Plan',
            skillTitle: 'Terraform Blast-Radius Layering, OPA Gates & Argo Rollouts Canary',
            description: 'Fail PR plans violating encryption, public exposure, or tagging invariants.',
            deliverables: ['Rego policy suite', 'CI plan -json gate'],
            labObjective: 'Write a Rego rule blocking unencrypted storage or 0.0.0.0/0 SSH rules.',
          },
          {
            id: 'do-2-3',
            title: 'KEDA Event-Driven Queue Autoscaling',
            skillTitle: 'Kubernetes Scheduler, QoS & Pod Disruption Budgets',
            description: 'Scale build/worker replicas from SQS/PubSub backlog depth before CPU spikes.',
            deliverables: ['KEDA ScaledObject', 'Cooldown stabilization window'],
            labObjective: 'Enqueue burst messages and verify scale-out from 2 to 8 pods cleanly.',
          },
        ],
      },
      {
        stageNumber: 3,
        title: 'Staff Kubernetes Reliability & Zero-Downtime',
        targetTier: 'Top 1%',
        milestoneGoal: 'Eliminate spot-drain 502s, OOMKill cascades, and etcd pod bloat.',
        steps: [
          {
            id: 'do-3-1',
            title: 'Kubernetes QoS, cgroups v2 & PodDisruptionBudgets',
            skillTitle: 'Kubernetes Scheduler, QoS & Pod Disruption Budgets',
            description: 'Protect critical gateways via Guaranteed QoS, PriorityClass, and topology spread.',
            deliverables: ['Guaranteed QoS spec', 'minAvailable PDB'],
            labObjective: 'Drain a live cluster node under traffic with zero dropped connections.',
          },
          {
            id: 'do-3-2',
            title: 'ALB / Ingress preStop Grace Drains',
            skillTitle: 'Kubernetes QoS, PodDisruptionBudgets & Zero-Downtime Drains',
            description: 'Synchronize target-group deregistration before SIGTERM hits uvicorn/nginx.',
            deliverables: ['preStop sleep 5 hook', '0% rolling-deploy 502s'],
            labObjective: 'Run k6 load during Deployment rollout and prove zero 502/reset responses.',
          },
          {
            id: 'do-3-3',
            title: 'Argo Workflows CRD Automation & Pod-Proxy',
            skillTitle: 'GitOps Progressive Delivery & Supply Chain Security',
            description: 'Submit/reap workflow CRDs dynamically with ttlStrategy and bounded compute tiers.',
            deliverables: ['ttlStrategy GC', 'Tiered resource limits'],
            labObjective: 'Launch a multi-step DAG Workflow CRD and verify auto-cleanup on completion.',
          },
        ],
      },
      {
        stageNumber: 4,
        title: 'Top 1% Principal GitOps & Supply Chain',
        targetTier: 'Top 1%',
        milestoneGoal: 'Guarantee cryptographic artifact trust and automated canary self-healing.',
        steps: [
          {
            id: 'do-4-1',
            title: 'Argo Rollouts Canary Analysis & Automated Rollback',
            skillTitle: 'Terraform Blast-Radius Layering, OPA Gates & Argo Rollouts Canary',
            description: 'Drive progressive traffic weights verified by live Prometheus AnalysisTemplates.',
            deliverables: ['10%->50%->100% canary', 'Auto-abort on 5xx threshold'],
            labObjective: 'Deploy an intentional error canary and confirm Argo aborts at 10% weight.',
          },
          {
            id: 'do-4-2',
            title: 'Keyless OIDC CI, Cosign Signatures & SLSA Provenance',
            skillTitle: 'Supply Chain Security (SLSA, Cosign) & Multi-Burn SLOs',
            description: 'Eliminate static registry keys and block unsigned containers at admission.',
            deliverables: ['Keyless Cosign signing', 'Kyverno signature policy'],
            labObjective: 'Verify cluster rejects an unsigned image push immediately at admission.',
          },
          {
            id: 'do-4-3',
            title: 'Distributed OpenTelemetry Pipeline & Tail Sampling',
            skillTitle: 'SLO Error Budgets & Multi-Burn-Rate Alerting',
            description: 'Operate Collector pipelines correlating Ingress, FastAPI, SQS, and DB spans.',
            deliverables: ['OTel Collector config', 'Trace-linked Prometheus exemplars'],
            labObjective: 'Jump directly from a p99 latency spike alert to the offending SQL trace.',
          },
        ],
      },
    ],
  },
  AWS: {
    visionSummary:
      'Level up from basic AWS resource provisioning to Top 1% multi-account SCP governance, IAM math, zero-NAT PrivateLink networking, resilient SQS/S3 pipelines, and Aurora DR.',
    stages: [
      {
        stageNumber: 1,
        title: 'Foundational Core & Access Pattern Modeling',
        targetTier: 'Foundational',
        milestoneGoal: 'Model DynamoDB access patterns cleanly and control cloud FinOps waste.',
        steps: [
          {
            id: 'aws-1-1',
            title: 'DynamoDB Single-Table PK/SK Design & Hot-Key Defense',
            skillTitle: 'DynamoDB Single-Table Design & FinOps',
            description: 'Design composite keys + sparse GSIs without Scans and prevent 1,000-WCU hot keys.',
            deliverables: ['Access-pattern matrix', 'Key-salting design'],
            labObjective: 'Serve 4 relational query patterns from a single DynamoDB table with Query only.',
          },
          {
            id: 'aws-1-2',
            title: 'S3 Multipart Presigned Uploads & CORS ETag Mastery',
            skillTitle: 'DynamoDB Single-Table Design & FinOps',
            description: 'Configure presigned Put/UploadPart flows with ExposeHeaders: ["ETag"] and lifecycle rules.',
            deliverables: ['AbortIncompleteMultipartUpload rule', 'CORS ETag exposure'],
            labObjective: 'Complete a direct-to-S3 multipart upload and clean stalled parts automatically.',
          },
          {
            id: 'aws-1-3',
            title: 'CloudFront + ALB Forwarded Headers & Preflight Cache',
            skillTitle: 'VPC Transit Gateway, PrivateLink & DNS Resolution',
            description: 'Preserve Origin/Authorization headers cleanly across CloudFront -> ALB -> FastAPI.',
            deliverables: ['CORS preflight pass-through', 'Origin Access Control (OAC)'],
            labObjective: 'Lock S3/ALB behind CloudFront without breaking browser OPTIONS preflights.',
          },
        ],
      },
      {
        stageNumber: 2,
        title: 'Senior Compute, Queue & EKS Architecture',
        targetTier: 'Senior',
        milestoneGoal: 'Scale EKS workloads seamlessly and build cost-optimal SQS worker loops.',
        steps: [
          {
            id: 'aws-2-1',
            title: 'EKS Pod Identity, IRSA & VPC CNI /28 Prefix Mode',
            skillTitle: 'EKS Control Plane, IRSA / Pod Identity & Karpenter',
            description: 'Eliminate subnet IP exhaustion and long-lived credentials on Kubernetes pods.',
            deliverables: ['Pod Identity association', 'VPC CNI prefix delegation'],
            labObjective: 'Verify pod assumes scoped AWS role cleanly with ephemeral STS tokens.',
          },
          {
            id: 'aws-2-2',
            title: 'Karpenter Spot Consolidation & NodePool Right-Sizing',
            skillTitle: 'SQS Long Polling, Visibility Heartbeats & EKS Karpenter',
            description: 'Replace static ASGs with sub-minute Karpenter provisioning and Graviton savings.',
            deliverables: ['Consolidation WhenUnderutilized', 'Spot interruption handling'],
            labObjective: 'Schedule diverse GPU/high-mem jobs via Karpenter NodePool constraints.',
          },
          {
            id: 'aws-2-3',
            title: 'SQS Long Polling, Visibility Heartbeat & DLQ Redrive',
            skillTitle: 'SQS Long Polling, Visibility Heartbeats & EKS Karpenter',
            description: 'Run WaitTimeSeconds=20, async ChangeMessageVisibility loops, and maxReceiveCount DLQs.',
            deliverables: ['Async heartbeat extension', 'Poison-pill DLQ isolation'],
            labObjective: 'Process a job longer than VisibilityTimeout with zero duplicate execution.',
          },
        ],
      },
      {
        stageNumber: 3,
        title: 'Staff Governance, IAM Math & Zero-NAT Mesh',
        targetTier: 'Top 1%',
        milestoneGoal: 'Enforce organization-wide security guardrails and eliminate NAT egress bloat.',
        steps: [
          {
            id: 'aws-3-1',
            title: 'IAM Policy Intersection & Permission Boundaries',
            skillTitle: 'Multi-Account Organizations & IAM Policy Boundaries',
            description: 'Debug SCP ∩ Resource ∩ Boundary ∩ Session ∩ Identity evaluation deterministically.',
            deliverables: ['Escalation-proof boundary', 'Organizations SCP guardrails'],
            labObjective: 'Block privilege escalation on developer-created roles using a Permission Boundary.',
          },
          {
            id: 'aws-3-2',
            title: 'Transit Gateway Segmentation & PrivateLink Endpoints',
            skillTitle: 'VPC Transit Gateway, PrivateLink & DNS Resolution',
            description: 'Keep S3/STS/ECR/Secrets traffic private with zero NAT Gateway data processing fees.',
            deliverables: ['Gateway + Interface endpoints', 'Split-horizon Route53 PHZ'],
            labObjective: 'Route private EKS pod traffic to S3 & Secrets Manager with zero NAT dependency.',
          },
          {
            id: 'aws-3-3',
            title: 'Zero-Static-Key OIDC Federation (GitHub & Cross-Cloud)',
            skillTitle: 'IAM Evaluation Chain, SCP Guardrails & PrivateLink Mesh',
            description: 'Eliminate all IAM Access Keys via short-lived STS AssumeRoleWithWebIdentity.',
            deliverables: ['Scoped `sub` OIDC condition', 'CloudTrail audit query'],
            labObjective: 'Bind a CI deploy role strictly to a single repo branch via OIDC claims.',
          },
        ],
      },
      {
        stageNumber: 4,
        title: 'Top 1% Principal Resilience & Multi-Region DR',
        targetTier: 'Top 1%',
        milestoneGoal: 'Survive connection storms and regional outages within strict RPO/RTO budgets.',
        steps: [
          {
            id: 'aws-4-1',
            title: 'RDS Proxy Connection Multiplexing & IAM DB Auth',
            skillTitle: 'DynamoDB Single-Table Design, RDS Proxy & Multi-Region DR',
            description: 'Protect Aurora PostgreSQL from max_connections exhaustion during Fargate/EKS spikes.',
            deliverables: ['RDS Proxy IAM auth', 'Pinning-avoidance audit'],
            labObjective: 'Absorb a 200-pod burst cleanly through RDS Proxy without Postgres OOM.',
          },
          {
            id: 'aws-4-2',
            title: 'Aurora Global Database & Route 53 Active-Passive Failover',
            skillTitle: 'DynamoDB Single-Table Design, RDS Proxy & Multi-Region DR',
            description: 'Architect <1s RPO cross-region storage replication and automated DNS health failover.',
            deliverables: ['Managed planned failover drill', 'RTO < 60s verification'],
            labObjective: 'Execute a failover game-day and document sequence of DNS + writer promotion.',
          },
          {
            id: 'aws-4-3',
            title: 'AWS FinOps Architecture & Unit-Cost Telemetry',
            skillTitle: 'IAM Evaluation Chain, SCP Guardrails & PrivateLink Mesh',
            description: 'Cut S3/NAT/EKS costs via VPC Gateway endpoints, Graviton, and per-tenant cost tagging.',
            deliverables: ['Cost-per-build metric', 'Zero orphaned EBS/NAT audit'],
            labObjective: 'Identify top 3 cloud spend levers across S3, NAT, and EKS compute.',
          },
        ],
      },
    ],
  },
  GCP: {
    visionSummary:
      'Advance from basic GCP services to Top 1% cryptographic VPC-SC perimeters, keyless Workload Identity Federation, GKE Gateway + Cloud Armor, and BigQuery/Spanner scale.',
    stages: [
      {
        stageNumber: 1,
        title: 'Foundational Event-Driven Cloud Run & Pub/Sub',
        targetTier: 'Foundational',
        milestoneGoal: 'Run serverless APIs cleanly with reliable asynchronous delivery.',
        steps: [
          {
            id: 'gcp-1-1',
            title: 'Cloud Run Concurrency, CPU Allocation & Cold-Start Tuning',
            skillTitle: 'Cloud Run, Pub/Sub & Eventarc Event-Driven Scale',
            description: 'Avoid background-task stalls using --no-cpu-throttling vs Cloud Tasks offloading.',
            deliverables: ['Optimal --concurrency tuning', 'Min-instances latency check'],
            labObjective: 'Benchmark async FastAPI concurrency on Cloud Run without stalled background tasks.',
          },
          {
            id: 'gcp-1-2',
            title: 'Pub/Sub ackDeadline, Dead-Letter Topics & Idempotency',
            skillTitle: 'Cloud Run, Pub/Sub & Eventarc Event-Driven Scale',
            description: 'Prevent duplicate push/pull processing with downstream DB idempotency keys.',
            deliverables: ['DLT poison-pill isolation', 'Consumer idempotency table'],
            labObjective: 'Simulate consumer crash pre-ack and confirm zero duplicate mutations on retry.',
          },
          {
            id: 'gcp-1-3',
            title: 'Artifact Registry Security & Cloud Build OIDC',
            skillTitle: 'Workload Identity Federation & IAM Hierarchy',
            description: 'Scan and promote container builds across environments with Binary Authorization.',
            deliverables: ['Least-privilege SA per service', 'Zero broad Editor roles'],
            labObjective: 'Deploy Cloud Run using a single-purpose runtime Service Account.',
          },
        ],
      },
      {
        stageNumber: 2,
        title: 'Senior GKE Autopilot & L7 Edge Defense',
        targetTier: 'Senior',
        milestoneGoal: 'Operate private GKE clusters behind Gateway API and adaptive Cloud Armor WAF.',
        steps: [
          {
            id: 'gcp-2-1',
            title: 'GKE Autopilot Private Nodes & Cloud NAT Egress',
            skillTitle: 'GKE Autopilot, Gateway API & Cloud Armor',
            description: 'Eliminate public node IPs and control cluster egress via Cloud NAT + Private Google Access.',
            deliverables: ['Private cluster control plane', 'Master authorized networks'],
            labObjective: 'Configure a private GKE Autopilot cluster reaching GCS/Artifact Registry cleanly.',
          },
          {
            id: 'gcp-2-2',
            title: 'GKE Gateway API Cross-Namespace Traffic Splitting',
            skillTitle: 'GKE Gateway API, Cloud Armor WAF & Cloud Run Concurrency',
            description: 'Replace fragmented Ingress annotations with standardized HTTPRoute canary weights.',
            deliverables: ['Multi-service Gateway', 'Weighted canary HTTPRoute'],
            labObjective: 'Split 10% live traffic to a canary backend via GKE Gateway API.',
          },
          {
            id: 'gcp-2-3',
            title: 'Cloud Armor L7 WAF & Adaptive Rate-Limiting',
            skillTitle: 'GKE Autopilot, Gateway API & Cloud Armor',
            description: 'Defend L7 endpoints against OWASP top-10 and per-IP/header abuse at Google edge.',
            deliverables: ['OWASP preconfigured rules', 'Rate-limit throttle policy'],
            labObjective: 'Verify Cloud Armor returns 429/403 at edge before traffic hits FastAPI pods.',
          },
        ],
      },
      {
        stageNumber: 3,
        title: 'Staff Perimeters & Keyless Multi-Cloud Auth',
        targetTier: 'Top 1%',
        milestoneGoal: 'Prevent data exfiltration and eliminate all exported service account JSON keys.',
        steps: [
          {
            id: 'gcp-3-1',
            title: 'Shared VPC Host-Service & Organization Policy Guardrails',
            skillTitle: 'VPC Service Controls & Shared VPC Architecture',
            description: 'Enforce centralized firewall/IP management and org policies disabling SA key creation.',
            deliverables: ['iam.disableServiceAccountKeyCreation', 'Shared VPC subnet IAM'],
            labObjective: 'Enforce org-wide Org Policy blocking external IP VMs and JSON keys.',
          },
          {
            id: 'gcp-3-2',
            title: 'VPC Service Controls Exfiltration Perimeters',
            skillTitle: 'VPC Service Controls, Shared VPC & Workload Identity Federation',
            description: 'Stop stolen valid credentials from copying BigQuery/GCS data to unauthorized projects.',
            deliverables: ['Dry-run perimeter audit', 'Explicit ingress/egress rules'],
            labObjective: 'Verify a cross-project gsutil/bq copy is blocked cleanly by VPC-SC.',
          },
          {
            id: 'gcp-3-3',
            title: 'Workload Identity Federation (AWS & GitHub -> GCP)',
            skillTitle: 'Workload Identity Federation & IAM Hierarchy',
            description: 'Exchange AWS STS / GitHub OIDC assertions for short-lived GCP credentials.',
            deliverables: ['Zero JSON key secrets', 'Attribute-mapped IAM principalSet'],
            labObjective: 'Authenticate from AWS/GitHub directly to GCS via Workload Identity Pool.',
          },
        ],
      },
      {
        stageNumber: 4,
        title: 'Top 1% Principal Data & Global Consistency',
        targetTier: 'Top 1%',
        milestoneGoal: 'Cut warehouse scan costs 90% and architect globally consistent storage.',
        steps: [
          {
            id: 'gcp-4-1',
            title: 'BigQuery Partition Pruning & Clustering Governance',
            skillTitle: 'BigQuery Partition/Clustering, Spanner & Pub/Sub Idempotency',
            description: 'Enforce require_partition_filter = TRUE and 4-column clustering on high-volume tables.',
            deliverables: ['require_partition_filter guard', '>85% bytes-scanned cut'],
            labObjective: 'Refactor an unpartitioned analytics table and verify Dry-Run byte savings.',
          },
          {
            id: 'gcp-4-2',
            title: 'Cloud Spanner TrueTime & Hot-Spot Key Modeling',
            skillTitle: 'BigQuery Partition/Clustering, Spanner & Pub/Sub Idempotency',
            description: 'Avoid monotonic timestamp PK hotspots and design interleaved child tables.',
            deliverables: ['UUIDv4 / bit-reversed keys', 'Interleaved schema'],
            labObjective: 'Model a multi-tenant ledger schema avoiding Spanner split hot-spotting.',
          },
          {
            id: 'gcp-4-3',
            title: 'Multi-Cloud AWS ↔ GCP Secure Interconnect & Telemetry',
            skillTitle: 'VPC Service Controls, Shared VPC & Workload Identity Federation',
            description: 'Unify STS/WIF authentication, HA VPN BGP failover, and central OTel observability.',
            deliverables: ['HA VPN BGP dual-tunnel', 'Cross-cloud WIF trust'],
            labObjective: 'Trace a multi-cloud workflow authenticating AWS EKS to GCP BigQuery keyless.',
          },
        ],
      },
    ],
  },
};

function buildStructuredDomainRoadmap(params: {
  domain: Domain;
  focusGoal?: string;
  skills: Array<{ domain: string; title: string; mastery: number }>;
  workLogs: Array<{ projectName: string; primaryDomain: string; taskSummary: string }>;
  completedMissions: Array<{ projectName: string; primaryDomain: string }>;
  existingCompletedStepTitles?: string[];
  existingCompletedJobTasks?: string[];
  aiNotice?: string;
}) {
  const blueprint = DOMAIN_ROADMAP_BLUEPRINTS[params.domain] || DOMAIN_ROADMAP_BLUEPRINTS.AWS;
  const completedStepLower = new Set(
    (params.existingCompletedStepTitles || []).map((t) => t.toLowerCase())
  );
  const completedJobs = Array.from(
    new Set([
      ...(params.existingCompletedJobTasks || []),
      ...(params.completedMissions || [])
        .filter((m) => normalizeDomain(m.primaryDomain, m.projectName, params.domain) === params.domain)
        .map((m) => m.projectName),
      ...(params.workLogs || [])
        .filter((l) => normalizeDomain(l.primaryDomain, l.projectName, params.domain) === params.domain)
        .map((l) => l.projectName),
    ])
  ).slice(0, 15);

  const nowIso = new Date().toISOString();
  const stages = blueprint.stages.map((st) => ({
    ...st,
    steps: st.steps.map((step) => {
      const matchedSkill = (params.skills || []).find(
        (sk) =>
          sk.title.toLowerCase() === step.skillTitle.toLowerCase() ||
          sk.title.toLowerCase() === step.title.toLowerCase()
      );
      const alreadyDone =
        completedStepLower.has(step.title.toLowerCase()) ||
        (matchedSkill ? matchedSkill.mastery >= 82 : false);

      const enrichedDescription =
        step.description.length >= 180
          ? step.description
          : `${step.description} In ${params.domain} (${st.targetTier} stage: ${st.title}), this milestone establishes production reliability toward "${st.milestoneGoal}" by delivering ${step.deliverables.join(', ')}.`;

      const enrichedGuide =
        step.detailedGuide ||
        `1. Core Architecture: Master the internal execution model behind ${step.title} (linked to ${step.skillTitle}) instead of treating configuration as a black box.\n2. Implementation Sequence: Build and verify ${step.deliverables.join(' -> ')}.\n3. Verification Standard: ${step.labObjective}`;

      const enrichedPitfalls =
        step.keyPitfalls && step.keyPitfalls.length > 0
          ? step.keyPitfalls
          : [
              `Shipping ${step.title} with default timeout, concurrency, or permission settings that fail under peak load.`,
              `Skipping deterministic verification for "${step.labObjective}" before promoting to production.`,
            ];

      return {
        ...step,
        description: enrichedDescription,
        detailedGuide: enrichedGuide,
        keyPitfalls: enrichedPitfalls,
        completed: alreadyDone,
        completedAt: alreadyDone ? nowIso : '',
        completedJobTaskTag: '',
      };
    }),
  }));

  return {
    roadmap: {
      id: `roadmap-${params.domain}`,
      domain: params.domain,
      title: `${params.domain} Top 1% Principal Roadmap`,
      designedBy: 'JARVIS' as const,
      visionSummary: params.focusGoal?.trim()
        ? `${blueprint.visionSummary} Focus priority: ${params.focusGoal.trim()}`
        : blueprint.visionSummary,
      targetRank: 'Top 1% Principal',
      stages,
      completedJobTasks: completedJobs,
      updatedAtIso: nowIso,
    },
    aiNotice: params.aiNotice,
  };
}

app.post('/api/ai/design-roadmap', async (req, res) => {
  const {
    domain: rawDomain,
    focusGoal,
    skills,
    workLogs,
    completedMissions,
    existingCompletedStepTitles,
    existingCompletedSteps,
    existingCompletedJobTasks,
  } = (req.body || {}) as {
    domain?: string;
    focusGoal?: string;
    skills?: Array<{ domain: string; title: string; tier: string; mastery: number }>;
    workLogs?: Array<{ projectName: string; primaryDomain: string; taskSummary: string }>;
    completedMissions?: Array<{ projectName: string; primaryDomain: string }>;
    existingCompletedStepTitles?: string[];
    existingCompletedSteps?: Array<{
      title: string;
      skillTitle?: string;
      completedAt?: string;
      completedJobTaskTag?: string;
    }>;
    existingCompletedJobTasks?: string[];
  };

  const priorCompletedMap = new Map<
    string,
    { completedAt: string; completedJobTaskTag: string }
  >();
  for (const t of existingCompletedStepTitles || []) {
    if (typeof t === 'string' && t.trim()) {
      priorCompletedMap.set(t.trim().toLowerCase(), {
        completedAt: '',
        completedJobTaskTag: '',
      });
    }
  }
  for (const st of existingCompletedSteps || []) {
    if (st?.title?.trim()) {
      priorCompletedMap.set(st.title.trim().toLowerCase(), {
        completedAt: st.completedAt || '',
        completedJobTaskTag: st.completedJobTaskTag || '',
      });
    }
    if (st?.skillTitle?.trim()) {
      priorCompletedMap.set(st.skillTitle.trim().toLowerCase(), {
        completedAt: st.completedAt || '',
        completedJobTaskTag: st.completedJobTaskTag || '',
      });
    }
  }

  const domain = normalizeDomain(rawDomain, focusGoal || '', 'AWS');

  try {
    const domSkillsText = (skills || [])
      .filter((s) => normalizeDomain(s.domain, s.title, domain) === domain)
      .map((s) => `- [${s.tier} | ${s.mastery}%] ${s.title}`)
      .join('\n');

    const workText = (workLogs || [])
      .filter((w) => normalizeDomain(w.primaryDomain, w.projectName, domain) === domain)
      .slice(0, 8)
      .map((w) => `- ${w.projectName}: ${w.taskSummary.slice(0, 140)}`)
      .join('\n');

    const response = await generateWithModelFallback({
      model: 'gemini-4-hydrogen',
      contents: `Design a Top 1% Principal Engineering Roadmap for domain: ${domain}.
Focus Goal: ${focusGoal || 'Complete mastery from Foundational to Top 1% Principal level'}

Current ${domain} Skill Nodes:
${domSkillsText || 'Default starter skills'}

Completed / Logged ${domain} Work Tasks:
${workText || 'None logged yet'}

Previously Checked Roadmap Steps:
${(existingCompletedStepTitles || []).join(', ') || 'None'}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.XHIGH },
        systemInstruction: `You are JARVIS, Principal Curriculum Architect. Design a razor-sharp 4-stage roadmap.sh-style mastery tree for ${domain} progressing through:
Stage 1: Foundational Core (targetTier: "Foundational")
Stage 2: Senior Production Craft (targetTier: "Senior")
Stage 3: Staff Architecture & Failure Modes (targetTier: "Top 1%")
Stage 4: Top 1% Principal Mastery (targetTier: "Top 1%")
Include 3 concrete steps per stage (12 total). For EVERY step:
- description: Provide a thorough 3-4 sentence explanation (260-550 chars) of what the concept is, how it works internally, and why Staff/Top 1% engineers master it.
- detailedGuide: Provide a crisp step-by-step deep dive (400-850 chars) covering architecture mechanics, production configuration patterns, and trade-offs.
- keyPitfalls: List 2-3 specific production failure modes or anti-patterns to avoid.
- deliverables: 2-4 concrete engineering artifacts to build.
- labObjective: Concrete verification test proving mastery.
Link each step's skillTitle to an existing Skill Node title where it matches cleanly, or introduce a high-signal Top 1% module title. Mark steps completed=true if the engineer's skill mastery is >=82% or clearly proven in Completed/Logged Work Tasks or Previously Checked Roadmap Steps.`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            visionSummary: { type: Type.STRING },
            targetRank: { type: Type.STRING },
            stages: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  stageNumber: { type: Type.INTEGER },
                  title: { type: Type.STRING },
                  targetTier: {
                    type: Type.STRING,
                    enum: ['Foundational', 'Senior', 'Top 1%'],
                  },
                  milestoneGoal: { type: Type.STRING },
                  steps: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        skillTitle: { type: Type.STRING },
                        description: { type: Type.STRING },
                        detailedGuide: { type: Type.STRING },
                        keyPitfalls: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                        deliverables: {
                          type: Type.ARRAY,
                          items: { type: Type.STRING },
                        },
                        labObjective: { type: Type.STRING },
                        completed: { type: Type.BOOLEAN },
                      },
                      required: [
                        'id',
                        'title',
                        'skillTitle',
                        'description',
                        'detailedGuide',
                        'keyPitfalls',
                        'deliverables',
                        'labObjective',
                        'completed',
                      ],
                    },
                  },
                },
                required: ['stageNumber', 'title', 'targetTier', 'milestoneGoal', 'steps'],
              },
            },
          },
          required: ['title', 'visionSummary', 'targetRank', 'stages'],
        },
      },
    });

    const parsed = parseJsonResponse(response.text, 'design-roadmap');
    const nowIso = new Date().toISOString();
    const rawStages = Array.isArray(parsed.stages) ? parsed.stages : [];
    const fallbackBp = buildStructuredDomainRoadmap({
      domain,
      focusGoal,
      skills: skills || [],
      workLogs: workLogs || [],
      completedMissions: completedMissions || [],
      existingCompletedStepTitles,
      existingCompletedJobTasks,
    });

    const stages =
      rawStages.length >= 3
        ? rawStages.slice(0, 4).map((st, sIdx) => {
            const stObj = st as Record<string, unknown>;
            const rawSteps = Array.isArray(stObj.steps) ? stObj.steps : [];
            return {
              stageNumber: Number(stObj.stageNumber) || sIdx + 1,
              title: asString(stObj.title, `Stage ${sIdx + 1}`),
              targetTier: normalizeEnum(stObj.targetTier, VALID_TIERS, 'Top 1%'),
              milestoneGoal: asString(stObj.milestoneGoal, `Master Stage ${sIdx + 1} in ${domain}.`),
              steps: rawSteps.slice(0, 4).map((step, stIdx) => {
                const sp = step as Record<string, unknown>;
                const stepTitle = asString(sp.title, `${domain} Milestone ${sIdx + 1}.${stIdx + 1}`);
                const skillTitle = asString(sp.skillTitle, stepTitle);
                const priorMatch =
                  priorCompletedMap.get(stepTitle.toLowerCase()) ||
                  priorCompletedMap.get(skillTitle.toLowerCase()) ||
                  null;
                const done = Boolean(sp.completed) || Boolean(priorMatch);
                const deliverables = Array.isArray(sp.deliverables)
                  ? sp.deliverables.map((d) => asString(d)).filter(Boolean).slice(0, 4)
                  : ['Production config', 'Verification test'];
                const labObjective = asString(sp.labObjective, `Implement and verify ${stepTitle}.`);
                const keyPitfalls = Array.isArray(sp.keyPitfalls)
                  ? sp.keyPitfalls.map((p) => asString(p)).filter(Boolean).slice(0, 3)
                  : [
                      `Relying on default settings for ${stepTitle} without load/failure validation.`,
                    ];
                return {
                  id: asString(sp.id, `${domain.toLowerCase()}-${sIdx + 1}-${stIdx + 1}`).replace(
                    /[^a-zA-Z0-9_-]/g,
                    '-'
                  ),
                  title: stepTitle,
                  skillTitle,
                  description: asString(sp.description, `Master production internals for ${stepTitle}.`),
                  detailedGuide: asString(
                    sp.detailedGuide,
                    `Implement ${deliverables.join(', ')} and validate edge cases via: ${labObjective}`
                  ),
                  keyPitfalls,
                  deliverables,
                  labObjective,
                  completed: done,
                  completedAt: done ? priorMatch?.completedAt || nowIso : '',
                  completedJobTaskTag: priorMatch?.completedJobTaskTag || '',
                };
              }),
            };
          })
        : fallbackBp.roadmap.stages;

    res.json({
      roadmap: {
        id: `roadmap-${domain}`,
        domain,
        title: asString(parsed.title, `${domain} Top 1% Principal Roadmap`),
        designedBy: 'JARVIS' as const,
        visionSummary: asString(parsed.visionSummary, fallbackBp.roadmap.visionSummary),
        targetRank: asString(parsed.targetRank, 'Top 1% Principal'),
        stages,
        completedJobTasks: Array.from(
          new Set([
            ...(existingCompletedJobTasks || []),
            ...(fallbackBp.roadmap.completedJobTasks || []),
          ])
        ),
        updatedAtIso: nowIso,
      },
    });
  } catch (error) {
    if (isQuotaOrBillingError(error)) {
      console.warn(`[design-roadmap] Using structured JARVIS roadmap blueprint for ${domain}.`);
      res.json(
        buildStructuredDomainRoadmap({
          domain,
          focusGoal,
          skills: skills || [],
          workLogs: workLogs || [],
          completedMissions: completedMissions || [],
          existingCompletedStepTitles,
          existingCompletedJobTasks,
          aiNotice: AI_QUOTA_NOTICE,
        })
      );
      return;
    }
    handleAiError(res, error, 'design-roadmap');
  }
});

app.post('/api/ai/jarvis', async (req, res) => {
  const {
    userMessage,
    trigger,
    currentScreen,
    conversationHistory,
    context,
  } = (req.body || {}) as {
    userMessage?: string;
    trigger?: 'user_chat' | 'post_upload_brief' | 'proactive_scan';
    currentScreen?: {
      activePage: JarvisPage;
      profileDomainFilter?: Domain | 'All';
      selectedSkillTitle?: string | null;
    };
    conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
    context?: {
      weeklyHoursTarget?: number;
      streakDays?: number;
      rotationMap?: Record<string, string>;
      domainFocusMinutes?: Record<string, number>;
      activeProject?: JarvisProjectContext | null;
      skills?: JarvisSkillContext[];
      todayQuests?: JarvisQuestContext[];
    };
  };

  const effectiveTrigger = trigger || 'user_chat';
  const effectiveMessage =
    asString(userMessage) ||
    (effectiveTrigger === 'post_upload_brief'
      ? 'Analyze the newly uploaded project task, tell me the exact execution plan, and focus my screen on where to start.'
      : 'Analyze my current tasks and tell me what to do next.');

  const safeScreen = currentScreen || { activePage: 'quests', profileDomainFilter: 'All' };
  const skills = Array.isArray(context?.skills) ? context.skills : [];
  const todayQuests = Array.isArray(context?.todayQuests) ? context.todayQuests : [];
  const activeProject = context?.activeProject || null;
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];

  try {
    const projectSummary = activeProject
      ? `ACTIVE PROJECT: ${activeProject.projectName} (${activeProject.rank} | Primary: ${activeProject.primaryDomain})
Goal: ${activeProject.masteryGoal}
Modules:
${(activeProject.masterSyllabusModules || [])
  .map((m, i) => `  ${i + 1}. [${m.domain}] ${m.title}: ${m.objective} | Internals: ${m.keyInternals}`)
  .join('\n')}`
      : 'ACTIVE PROJECT: None (Balanced Normal Routine active)';

    const questsSummary =
      todayQuests.length > 0
        ? todayQuests
            .map(
              (q, i) =>
                `${i + 1}. [id=${q.id}] [${q.status.toUpperCase()}] [${q.rank} | ${q.domain} | ${q.questType} | ${q.estimatedMinutes}m | +${q.xpReward}XP] ${q.title} — ${q.objective}`
            )
            .join('\n')
        : 'No quests issued yet for today.';

    const domainAudit = buildTop1DomainAudit(skills, context?.domainFocusMinutes);
    const domainAuditSummary = domainAudit
      .map(
        (r) =>
          `- ${r.domain}: avgMastery=${r.avgMastery}% | Top1%Ready=${r.top1ReadyCount}/${r.top1Count} | nodes=${r.nodeCount} | weeklyFocus=${r.focusMinutes}m | weakest="${r.weakestSkill?.title || 'None'}" (${r.weakestSkill?.mastery ?? 0}%)`
      )
      .join('\n');

    const topSkillsSummary = [...skills]
      .sort((a, b) => {
        const p = (v: string) => (v === 'Critical' ? 0 : v === 'High' ? 1 : 2);
        return p(a.priority) - p(b.priority) || a.mastery - b.mastery;
      })
      .slice(0, 60)
      .map((s) => `- [${s.domain} | ${s.tier} | ${s.priority} | ${s.mastery}%] ${s.title}`)
      .join('\n');

    const historyBlock = history
      .slice(-8)
      .map((m) => `${m.role === 'user' ? 'Engineer' : 'JARVIS'}: ${m.content}`)
      .join('\n');

    const response = await generateWithModelFallback({
      model: 'gemini-4-hydrogen',
      contents: `Trigger: ${effectiveTrigger}
Current Screen: page=${safeScreen.activePage}, domainFilter=${safeScreen.profileDomainFilter || 'All'}, openSkill=${safeScreen.selectedSkillTitle || 'None'}
Streak: ${context?.streakDays || 1}d | Weekly Target: ${context?.weeklyHoursTarget || 10}h
Current Mon-Sun Rotation: ${JSON.stringify(context?.rotationMap || {})}

5-DOMAIN TOP 1% READINESS TELEMETRY:
${domainAuditSummary}

${projectSummary}

TODAY'S DAILY QUESTS:
${questsSummary}

FULL SYLLABUS MATRIX (Domain | Tier | Priority | Mastery):
${topSkillsSummary}

RECENT CHAT:
${historyBlock || 'None'}

ENGINEER REQUEST / DOUBT:
${effectiveMessage}`,
      config: {
        thinkingConfig: { thinkingLevel: ThinkingLevel.XHIGH },
        systemInstruction: `You are JARVIS, a Supreme Principal & Distinguished Engineering Mentor + Top 1% Syllabus Architect inside ApexStack.
PRIMARY GOAL: Transform the engineer into the **Top 1%** across ALL FIVE learning-path domains (**Angular**, **FastAPI**, **DevOps**, **AWS**, **GCP**) plus **Multi-Cloud Synthesis** by diagnosing blind spots, dynamically structuring their syllabus, running Socratic drills, grading their engineering reasoning, and directly boosting mastery when earned.

Supreme 5-Domain Principal Standards:
- **Angular**: Fine-grained Signals & glitch-free topological reactivity, Zoneless CD (\`provideZonelessChangeDetection\`), SSR Incremental Hydration (\`@defer\`, \`TransferState\`, \`withEventReplay\`), Web Workers for <100ms INP, RxJS backpressure (\`switchMap\` vs \`exhaustMap\` vs \`concatMap\`), \`takeUntilDestroyed\`, resilient full-jitter retry interceptors, OIDC PKCE.
- **FastAPI**: Asyncio non-blocking event-loop discipline, \`lifespan\` pool sizing, Pydantic v2 Rust core, ACID \`SELECT ... FOR UPDATE\` + idempotency keys, zero-lock 3-step Postgres migrations (\`NOT VALID\` -> \`VALIDATE CONSTRAINT\`), Redis Lua token-bucket rate limiting, disconnect-aware \`StreamingResponse\`, OpenTelemetry \`traceparent\` propagation, DuckDB/PyArrow zero-copy S3 profiling.
- **DevOps**: Kubernetes QoS/cgroups v2/PDBs, zero-downtime drains (\`preStop\` + \`readinessProbe\`), KEDA queue-depth scaling, Argo Workflows & Argo Rollouts metric-gated canary analysis, Terraform blast-radius state layering + OPA Conftest gates, SLSA/Cosign keyless supply-chain security, SLO multi-window burn-rate PromQL alerting.
- **AWS**: Multi-account Organizations SCPs, IAM evaluation chain (\`Identity ∩ Resource ∩ Permission Boundary ∩ Session ∩ SCP\`), EKS Pod Identity/IRSA/Karpenter/VPC CNI prefix delegation (\`/28\`), Transit Gateway & PrivateLink zero-NAT architecture, S3 multipart CORS (\`ExposeHeaders: ["ETag"]\`), SQS long polling/visibility heartbeats/DLQ, DynamoDB single-table PK/SK + hot-key salting, RDS Proxy + Aurora Global DR.
- **GCP**: VPC Service Controls exfiltration perimeters & Shared VPC, keyless Workload Identity Federation, GKE Autopilot + Gateway API + Cloud Armor adaptive WAF, Cloud Run concurrency & \`--no-cpu-throttling\`, Pub/Sub \`ackDeadline\`/DLT + downstream idempotency, BigQuery \`require_partition_filter\` + clustering, Cloud Spanner TrueTime.

Allowed uiActions objects:
- \`{ "type": "design_roadmap", "domain": "Angular" | "FastAPI" | "DevOps" | "AWS" | "GCP" | "All", "focusGoal": "..." }\`
  USE THIS whenever the engineer asks JARVIS to design, build, architect, or upgrade a domain roadmap (or all 5 domain roadmaps). Pair with \`{ "type": "navigate", "page": "roadmaps", "domainFilter": "<Domain>" }\`.
- \`{ "type": "mark_job_task_done", "projectName": "<job task name>", "domain": "<Domain>", "taskSummary": "<summary>", "resumePath": true }\`
  USE THIS whenever the engineer says they ALREADY / PRIORLY completed a job task or finished an active project and want to mark it done, get mastery credit, and resume their normal learning path! Pair with \`{ "type": "navigate", "page": "roadmaps", "domainFilter": "<Domain>" }\`.
- \`{ "type": "structure_syllabus", "summary": "...", "weeklyFocusOrder": ["GCP","DevOps","AWS","FastAPI","Angular"], "addTopics": [...], "updateTopics": [...], "newReviewCards": [...] }\`
  USE THIS whenever the engineer asks to structure/optimize/upgrade their syllabus, make them Top 1%, audit/close domain gaps, or when a domain is lagging (<50% avg or lacking Top 1% nodes). Keep \`weeklyFocusOrder\` as all 5 unique domains ordered from highest urgency Mon to Fri. For \`updateTopics\`, reference \`existingTitle\` verbatim from FULL SYLLABUS MATRIX. Give every new topic a deep \`studyBrief\` (internals, failure modes, verification) and 45-min \`labPrompt\`, plus 1-3 SM-2 \`newReviewCards\`.
- \`{ "type": "award_skill_practice", "skillTitle": "<exact title from FULL SYLLABUS MATRIX>", "domain": "<Domain>", "masteryBoost": 4..10 }\`
  USE THIS whenever the engineer gives a strong/accurate technical explanation, solves a quiz question, or demonstrates Staff-level mastery in conversation so their skill matrix mastery increases immediately!
- \`{ "type": "navigate", "page": "quests" | "roadmaps" | "upload" | "profile", "domainFilter": "All" | "Angular" | "FastAPI" | "DevOps" | "AWS" | "GCP" }\`
- \`{ "type": "open_skill", "skillTitle": "<title from FULL SYLLABUS MATRIX or newly added topic>", "domain": "<Domain>" }\`
- \`{ "type": "focus_quest", "questIdOrTitle": "<id or title from TODAY'S DAILY QUESTS>" }\`
- \`{ "type": "complete_quest", "questIdOrTitle": "<id or title>" }\`
- \`{ "type": "refresh_study_brief", "skillTitle": "<title>", "domain": "<Domain>" }\`
- \`{ "type": "prefill_upload", "projectName": "<optional>", "rawTaskBrief": "<brief text>" }\`
- \`{ "type": "refresh_quests" }\`
- \`{ "type": "close_skill_drawer" }\`

Rules:
- Ground every answer in the engineer's actual 5-domain telemetry, syllabus nodes, and active project.
- Act as an active Principal coach: don't just lecture — challenge assumptions, highlight silent failure modes, ask high-signal diagnostic follow-ups, and reward real mastery with \`award_skill_practice\`.
- FORMATTING (CRITICAL for readability): NEVER return a single wall-of-text paragraph. Structure \`reply\` using short \`###\` headings, crisp bullet lists (\`- **Label**: concise point\`) or numbered steps (\`1. ...\`), \`inline code\` for APIs/flags/commands, and blank lines between sections. Keep each bullet or paragraph to 1–2 short sentences.
- Include \`codeSnippet\` whenever concrete TypeScript/Python/SQL/Terraform/YAML/gcloud/IAM code deepens mastery.
- Set \`interactiveMode\` to \`"quiz"\` when posing/grading a Staff-level challenge question, \`"walkthrough"\` for step-by-step task guides, or \`"mentor"\` otherwise.`,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            headline: { type: Type.STRING },
            reply: { type: Type.STRING },
            codeSnippet: { type: Type.STRING },
            interactiveMode: {
              type: Type.STRING,
              enum: ['mentor', 'walkthrough', 'quiz'],
            },
            uiActions: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  type: {
                    type: Type.STRING,
                    enum: [
                      'design_roadmap',
                      'mark_job_task_done',
                      'structure_syllabus',
                      'award_skill_practice',
                      'navigate',
                      'open_skill',
                      'focus_quest',
                      'complete_quest',
                      'refresh_study_brief',
                      'prefill_upload',
                      'refresh_quests',
                      'close_skill_drawer',
                    ],
                  },
                  summary: { type: Type.STRING },
                  focusGoal: { type: Type.STRING },
                  taskSummary: { type: Type.STRING },
                  resumePath: { type: Type.BOOLEAN },
                  masteryBoost: { type: Type.INTEGER },
                  weeklyFocusOrder: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.STRING,
                      enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                    },
                  },
                  addTopics: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        domain: {
                          type: Type.STRING,
                          enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                        },
                        title: { type: Type.STRING },
                        tier: {
                          type: Type.STRING,
                          enum: ['Foundational', 'Senior', 'Top 1%'],
                        },
                        priority: {
                          type: Type.STRING,
                          enum: ['Critical', 'High', 'Normal'],
                        },
                        description: { type: Type.STRING },
                        studyBrief: { type: Type.STRING },
                        labPrompt: { type: Type.STRING },
                      },
                      required: [
                        'domain',
                        'title',
                        'tier',
                        'priority',
                        'description',
                        'studyBrief',
                        'labPrompt',
                      ],
                    },
                  },
                  updateTopics: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        existingTitle: { type: Type.STRING },
                        tier: {
                          type: Type.STRING,
                          enum: ['Foundational', 'Senior', 'Top 1%'],
                        },
                        priority: {
                          type: Type.STRING,
                          enum: ['Critical', 'High', 'Normal'],
                        },
                        projectTag: { type: Type.STRING },
                        updatedStudyBrief: { type: Type.STRING },
                        updatedLabPrompt: { type: Type.STRING },
                      },
                      required: ['existingTitle'],
                    },
                  },
                  newReviewCards: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        domain: {
                          type: Type.STRING,
                          enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                        },
                        skillTitle: { type: Type.STRING },
                        prompt: { type: Type.STRING },
                        answer: { type: Type.STRING },
                        explanation: { type: Type.STRING },
                      },
                      required: ['domain', 'skillTitle', 'prompt', 'answer', 'explanation'],
                    },
                  },
                  page: {
                    type: Type.STRING,
                    enum: ['quests', 'roadmaps', 'upload', 'profile'],
                  },
                  domainFilter: {
                    type: Type.STRING,
                    enum: ['All', 'Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  skillTitle: { type: Type.STRING },
                  domain: {
                    type: Type.STRING,
                    enum: ['All', 'Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
                  },
                  questIdOrTitle: { type: Type.STRING },
                  projectName: { type: Type.STRING },
                  rawTaskBrief: { type: Type.STRING },
                },
                required: ['type'],
              },
            },
            suggestedFollowUps: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
            },
          },
          required: ['headline', 'reply', 'uiActions', 'suggestedFollowUps'],
        },
      },
    });

    const parsed = parseJsonResponse(response.text, 'jarvis');
    const rawActions = Array.isArray(parsed.uiActions) ? parsed.uiActions : [];
    const normalizedActions: JarvisAction[] = [];

    for (const act of rawActions) {
      if (!act || typeof act !== 'object') continue;
      const a = act as Record<string, unknown>;
      const t = asString(a.type);
      if (t === 'structure_syllabus') {
        const rawOrder = Array.isArray(a.weeklyFocusOrder)
          ? a.weeklyFocusOrder
              .map((d) => normalizeDomain(d, '', 'AWS'))
              .filter((d, i, arr) => arr.indexOf(d) === i)
          : [];
        const weeklyFocusOrder =
          rawOrder.length > 0
            ? Array.from(new Set([...rawOrder, ...VALID_DOMAINS]))
            : undefined;

        const addTopics = Array.isArray(a.addTopics)
          ? a.addTopics
              .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
              .slice(0, 6)
              .map((x) => {
                const title = asString(x.title);
                const domain = normalizeDomain(x.domain, title, 'AWS');
                return {
                  domain,
                  title,
                  tier: normalizeEnum(x.tier, VALID_TIERS, 'Top 1%'),
                  priority: normalizeEnum(x.priority, VALID_PRIORITIES, 'High'),
                  description: asString(
                    x.description,
                    `Top 1% engineering mastery topic in ${domain}.`
                  ),
                  studyBrief: asString(
                    x.studyBrief,
                    `Master internals, production failure modes, and verification patterns for ${title}.`
                  ),
                  labPrompt: asString(
                    x.labPrompt,
                    `Implement and stress-test ${title} in a 45-minute production-grade lab.`
                  ),
                };
              })
              .filter((x) => x.title.length > 0)
          : undefined;

        const updateTopics = Array.isArray(a.updateTopics)
          ? a.updateTopics
              .filter((x): x is Record<string, unknown> => Boolean(x && typeof x === 'object'))
              .slice(0, 10)
              .map((x) => ({
                existingTitle: asString(x.existingTitle),
                tier: x.tier ? normalizeEnum(x.tier, VALID_TIERS, 'Top 1%') : undefined,
                priority: x.priority
                  ? normalizeEnum(x.priority, VALID_PRIORITIES, 'High')
                  : undefined,
                projectTag: typeof x.projectTag === 'string' ? x.projectTag.trim() : undefined,
                updatedStudyBrief: asString(x.updatedStudyBrief) || undefined,
                updatedLabPrompt: asString(x.updatedLabPrompt) || undefined,
              }))
              .filter((x) => x.existingTitle.length > 0)
          : undefined;

        const newReviewCards = Array.isArray(a.newReviewCards)
          ? a.newReviewCards
              .filter((c): c is Record<string, unknown> => Boolean(c && typeof c === 'object'))
              .slice(0, 4)
              .map((c) => {
                const skillTitle = asString(c.skillTitle, 'Top 1% Engineering');
                return {
                  domain: normalizeDomain(c.domain, skillTitle, 'AWS'),
                  skillTitle,
                  prompt: asString(c.prompt),
                  answer: asString(c.answer),
                  explanation: asString(c.explanation),
                };
              })
              .filter((c) => c.prompt.length > 0 && c.answer.length > 0)
          : undefined;

        normalizedActions.push({
          type: 'structure_syllabus',
          summary: asString(a.summary, 'Structured 5-domain syllabus for Top 1% mastery.'),
          weeklyFocusOrder,
          addTopics,
          updateTopics,
          newReviewCards,
        });
      } else if (t === 'navigate') {
        const page = normalizeEnum(
          a.page,
          ['quests', 'roadmaps', 'upload', 'profile'] as const,
          'quests'
        );
        const df = asString(a.domainFilter);
        const domainFilter =
          df === 'All'
            ? 'All'
            : VALID_DOMAINS.includes(df as Domain)
            ? (df as Domain)
            : undefined;
        normalizedActions.push({ type: 'navigate', page, domainFilter });
      } else if (t === 'design_roadmap') {
        const domRaw = asString(a.domain);
        const domain: Domain | 'All' =
          domRaw === 'All'
            ? 'All'
            : VALID_DOMAINS.includes(domRaw as Domain)
            ? (domRaw as Domain)
            : 'All';
        normalizedActions.push({
          type: 'design_roadmap',
          domain,
          focusGoal: asString(a.focusGoal) || undefined,
        });
      } else if (t === 'mark_job_task_done' && asString(a.projectName)) {
        const domRaw = asString(a.domain);
        normalizedActions.push({
          type: 'mark_job_task_done',
          projectName: asString(a.projectName),
          domain: VALID_DOMAINS.includes(domRaw as Domain) ? (domRaw as Domain) : undefined,
          taskSummary: asString(a.taskSummary) || undefined,
          resumePath: a.resumePath !== false,
        });
      } else if (t === 'open_skill' && asString(a.skillTitle)) {
        const dom = asString(a.domain);
        normalizedActions.push({
          type: 'open_skill',
          skillTitle: asString(a.skillTitle),
          domain: VALID_DOMAINS.includes(dom as Domain) ? (dom as Domain) : undefined,
        });
      } else if (t === 'focus_quest' && asString(a.questIdOrTitle)) {
        normalizedActions.push({
          type: 'focus_quest',
          questIdOrTitle: asString(a.questIdOrTitle),
        });
      } else if (t === 'complete_quest' && asString(a.questIdOrTitle)) {
        normalizedActions.push({
          type: 'complete_quest',
          questIdOrTitle: asString(a.questIdOrTitle),
        });
      } else if (t === 'refresh_study_brief' && asString(a.skillTitle)) {
        const dom = asString(a.domain);
        normalizedActions.push({
          type: 'refresh_study_brief',
          skillTitle: asString(a.skillTitle),
          domain: VALID_DOMAINS.includes(dom as Domain) ? (dom as Domain) : undefined,
        });
      } else if (t === 'award_skill_practice' && asString(a.skillTitle)) {
        const dom = asString(a.domain);
        const rawBoost = Number(a.masteryBoost);
        normalizedActions.push({
          type: 'award_skill_practice',
          skillTitle: asString(a.skillTitle),
          domain: VALID_DOMAINS.includes(dom as Domain) ? (dom as Domain) : undefined,
          masteryBoost: Number.isFinite(rawBoost) ? Math.min(12, Math.max(2, Math.round(rawBoost))) : 6,
        });
      } else if (t === 'prefill_upload') {
        normalizedActions.push({
          type: 'prefill_upload',
          projectName: asString(a.projectName) || undefined,
          rawTaskBrief: asString(a.rawTaskBrief) || undefined,
        });
      } else if (t === 'refresh_quests') {
        normalizedActions.push({ type: 'refresh_quests' });
      } else if (t === 'close_skill_drawer') {
        normalizedActions.push({ type: 'close_skill_drawer' });
      }
    }

    const suggestedFollowUps = Array.isArray(parsed.suggestedFollowUps)
      ? parsed.suggestedFollowUps.map((f) => asString(f)).filter(Boolean).slice(0, 3)
      : [];

    res.json({
      headline: asString(parsed.headline, 'JARVIS Command Briefing'),
      reply: asString(parsed.reply, 'Ready. Ask any doubt or command me to structure your Top 1% syllabus.'),
      codeSnippet: asString(parsed.codeSnippet) || undefined,
      interactiveMode: normalizeEnum(
        parsed.interactiveMode,
        ['mentor', 'walkthrough', 'quiz'] as const,
        'mentor'
      ),
      uiActions: normalizedActions,
      suggestedFollowUps,
    });
  } catch (error) {
    if (isQuotaOrBillingError(error)) {
      console.warn('[jarvis] Gemini quota/credits unavailable; using local JARVIS reasoning engine.');
      res.json(
        buildJarvisFallbackResponse({
          userMessage: effectiveMessage,
          trigger: effectiveTrigger,
          currentScreen: safeScreen,
          conversationHistory: history,
          activeProject,
          skills,
          todayQuests,
          streakDays: context?.streakDays,
          domainFocusMinutes: context?.domainFocusMinutes,
        })
      );
      return;
    }
    handleAiError(res, error, 'jarvis');
  }
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    process.env.DISABLE_HMR = 'true';
    app.get('/@vite/client', (_req, res) => {
      res.type('application/javascript').send(`
const sheetsMap = new Map();
export function updateStyle(id, content) {
  let style = sheetsMap.get(id);
  if (!style) {
    style = document.createElement('style');
    style.setAttribute('type', 'text/css');
    style.setAttribute('data-vite-dev-id', id);
    style.textContent = content;
    document.head.appendChild(style);
    sheetsMap.set(id, style);
  } else {
    style.textContent = content;
  }
}
export function removeStyle(id) {
  const style = sheetsMap.get(id);
  if (style) {
    document.head.removeChild(style);
    sheetsMap.delete(id);
  }
}
export function createHotContext() {
  return {
    data: {},
    accept() {},
    acceptExports() {},
    dispose() {},
    prune() {},
    decline() {},
    invalidate() {},
    on() {},
    off() {},
    send() {},
  };
}
export function injectQuery(url) {
  return url;
}
export class ErrorOverlay {}
`);
    });
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  const liveWss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const host = request.headers.host || 'localhost';
      const parsedUrl = new URL(request.url || '/', `http://${host}`);
      if (parsedUrl.pathname === '/api/live-jarvis') {
        liveWss.handleUpgrade(request, socket, head, (ws) => {
          liveWss.emit('connection', ws, request);
        });
      }
    } catch {
      socket.destroy();
    }
  });

  liveWss.on('connection', (clientWs: WebSocket) => {
    let liveSession: Awaited<ReturnType<GoogleGenAI['live']['connect']>> | null = null;
    let isClosing = false;
    let lastInteractionStatus: InteractionStatus | undefined;

    let sessionContext: {
      profile?: {
        weeklyHoursTarget?: number;
        streakDays?: number;
        rotationMap?: Record<string, string>;
        domainFocusMinutes?: Record<string, number>;
      };
      activeProject?: JarvisProjectContext | null;
      skills?: JarvisSkillContext[];
      todayQuests?: JarvisQuestContext[];
      currentScreen?: {
        activePage?: string;
        profileDomainFilter?: string;
        selectedSkillTitle?: string | null;
      };
    } = {};

    const safeSend = (payload: Record<string, unknown>) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(payload));
      }
    };

    const liveTools: FunctionDeclaration[] = [
      {
        name: 'structure_syllabus',
        description:
          'Audits the 5 learning-path domains (Angular, FastAPI, DevOps, AWS, GCP), inserts missing Top 1% Principal skill modules, prioritizes lagging domains in Mon-Fri rotation, and creates SM-2 recall cards.',
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            targetDomain: {
              type: Type.STRING,
              enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
              description: 'Optional domain to prioritize first in the syllabus restructuring.',
            },
            reason: {
              type: Type.STRING,
              description: 'Brief rationale for the syllabus adjustment.',
            },
          },
        },
      },
      {
        name: 'navigate_workspace',
        description:
          'Switches the ApexStack screen to quests, roadmaps, upload, or profile (with optional domain filter).',
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            page: {
              type: Type.STRING,
              enum: ['quests', 'roadmaps', 'upload', 'profile'],
            },
            domainFilter: {
              type: Type.STRING,
              enum: ['All', 'Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
            },
          },
          required: ['page'],
        },
      },
      {
        name: 'design_domain_roadmap',
        description:
          'Designs or upgrades a 4-stage Top 1% mastery roadmap for a specific domain or All domains and opens the Roadmaps screen.',
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            domain: {
              type: Type.STRING,
              enum: ['All', 'Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
            },
            focusGoal: {
              type: Type.STRING,
            },
          },
          required: ['domain'],
        },
      },
      {
        name: 'mark_job_task_done',
        description:
          'Marks an active or priorly completed job/project task done, credits domain mastery & roadmap progress, exits any active project override, and resumes the normal learning path.',
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            projectName: { type: Type.STRING },
            domain: {
              type: Type.STRING,
              enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
            },
            taskSummary: { type: Type.STRING },
          },
          required: ['projectName'],
        },
      },
      {
        name: 'open_skill_brief',
        description:
          'Opens a specific syllabus topic or the weakest skill in a domain side-by-side in the Study Brief drawer and returns its brief and lab details.',
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            skillTitle: {
              type: Type.STRING,
              description: 'Exact or partial skill title, or leave empty to pick the weakest node in the domain.',
            },
            domain: {
              type: Type.STRING,
              enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
            },
          },
        },
      },
      {
        name: 'focus_or_complete_quest',
        description: 'Focuses a quest on the Quests screen or marks it complete (+XP and mastery) when the engineer verifies completion.',
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            action: {
              type: Type.STRING,
              enum: ['focus', 'complete'],
            },
            questIdOrTitle: {
              type: Type.STRING,
            },
          },
          required: ['action', 'questIdOrTitle'],
        },
      },
      {
        name: 'award_skill_practice',
        description:
          'Awards mastery percentage (+4 to +10%) and practice count when the engineer accurately explains architecture internals or solves a voice drill question.',
        behavior: Behavior.NON_BLOCKING,
        parameters: {
          type: Type.OBJECT,
          properties: {
            skillTitle: { type: Type.STRING },
            domain: {
              type: Type.STRING,
              enum: ['Angular', 'FastAPI', 'DevOps', 'AWS', 'GCP'],
            },
            masteryBoost: {
              type: Type.INTEGER,
              description: 'Between 4 and 10 depending on depth of answer.',
            },
          },
          required: ['skillTitle'],
        },
      },
    ];

    const handleLiveToolCall = (call: { id?: string; name?: string; args?: Record<string, unknown> }) => {
      const name = call.name || '';
      const args = call.args || {};
      const skills = Array.isArray(sessionContext.skills) ? sessionContext.skills : [];
      const quests = Array.isArray(sessionContext.todayQuests) ? sessionContext.todayQuests : [];
      let toolResult: Record<string, unknown> = { ok: true };

      if (name === 'structure_syllabus') {
        const targetDom = typeof args.targetDomain === 'string' && VALID_DOMAINS.includes(args.targetDomain as Domain)
          ? (args.targetDomain as Domain)
          : undefined;
        const plan = buildTop1SyllabusPlan({
          skills,
          domainFocusMinutes: sessionContext.profile?.domainFocusMinutes,
          activeProject: sessionContext.activeProject,
          targetDomain: targetDom,
        });
        const actions: JarvisAction[] = [plan.action];
        const targetSkill = plan.orderedByGap[0]?.weakestSkill;
        if (targetSkill) {
          actions.push({
            type: 'open_skill',
            skillTitle: targetSkill.title,
            domain: normalizeDomain(targetSkill.domain, targetSkill.title, 'AWS'),
          });
        }
        safeSend({ type: 'actions', uiActions: actions });
        toolResult = {
          applied: true,
          summary: plan.action.summary,
          weeklyFocusOrder: plan.action.weeklyFocusOrder,
          addedTopics: plan.action.addTopics.map((t) => `[${t.domain}] ${t.title}`),
          audit: plan.audit.map((r) => `${r.domain}: ${r.avgMastery}% (${r.top1ReadyCount}/${r.top1Count} Top1% ready)`),
        };
      } else if (name === 'navigate_workspace') {
        const page = normalizeEnum(
          args.page,
          ['quests', 'roadmaps', 'upload', 'profile'] as const,
          'quests'
        );
        const df = asString(args.domainFilter);
        const domainFilter =
          df === 'All'
            ? 'All'
            : VALID_DOMAINS.includes(df as Domain)
            ? (df as Domain)
            : undefined;
        safeSend({
          type: 'actions',
          uiActions: [{ type: 'navigate', page, domainFilter } satisfies JarvisAction],
        });
        toolResult = { navigatedTo: page, domainFilter: domainFilter || 'All' };
      } else if (name === 'design_domain_roadmap') {
        const df = asString(args.domain);
        const domain: Domain | 'All' =
          df === 'All'
            ? 'All'
            : VALID_DOMAINS.includes(df as Domain)
            ? (df as Domain)
            : 'All';
        const navDom: Domain = domain === 'All' ? 'Angular' : domain;
        safeSend({
          type: 'actions',
          uiActions: [
            {
              type: 'design_roadmap',
              domain,
              focusGoal: asString(args.focusGoal) || undefined,
            },
            { type: 'navigate', page: 'roadmaps', domainFilter: navDom },
          ],
        });
        toolResult = { designingRoadmap: domain, openedRoadmapsScreen: navDom };
      } else if (name === 'mark_job_task_done') {
        const projectName = asString(
          args.projectName,
          sessionContext.activeProject?.projectName || 'Prior Job Task'
        );
        const df = asString(args.domain);
        const dom = VALID_DOMAINS.includes(df as Domain)
          ? (df as Domain)
          : sessionContext.activeProject?.primaryDomain
          ? normalizeDomain(sessionContext.activeProject.primaryDomain, '', 'AWS')
          : 'AWS';
        safeSend({
          type: 'actions',
          uiActions: [
            {
              type: 'mark_job_task_done',
              projectName,
              domain: dom,
              taskSummary: asString(args.taskSummary) || undefined,
              resumePath: true,
            },
            { type: 'navigate', page: 'roadmaps', domainFilter: dom },
          ],
        });
        toolResult = { markedDone: projectName, domain: dom, resumedNormalPath: true };
      } else if (name === 'open_skill_brief') {
        const dom = typeof args.domain === 'string' && VALID_DOMAINS.includes(args.domain as Domain)
          ? (args.domain as Domain)
          : undefined;
        const rawTitle = asString(args.skillTitle).toLowerCase();
        const pool = dom
          ? skills.filter((s) => normalizeDomain(s.domain, s.title, dom) === dom)
          : skills;
        const sortedPool = [...pool].sort((a, b) => a.mastery - b.mastery);
        const matched =
          (rawTitle
            ? pool.find((s) => s.title.toLowerCase() === rawTitle) ||
              pool.find((s) => s.title.toLowerCase().includes(rawTitle))
            : undefined) || sortedPool[0];

        if (matched) {
          safeSend({
            type: 'actions',
            uiActions: [
              {
                type: 'open_skill',
                skillTitle: matched.title,
                domain: normalizeDomain(matched.domain, matched.title, dom || 'AWS'),
              } satisfies JarvisAction,
            ],
          });
          toolResult = {
            opened: matched.title,
            domain: matched.domain,
            mastery: matched.mastery,
            studyBrief: matched.studyBrief || matched.description || '',
            labPrompt: matched.labPrompt || '',
          };
        } else {
          toolResult = { opened: false, message: 'No matching skill found in syllabus.' };
        }
      } else if (name === 'focus_or_complete_quest') {
        const act = args.action === 'complete' ? 'complete_quest' : 'focus_quest';
        const qArg = asString(args.questIdOrTitle, quests[0]?.id || quests[0]?.title || '');
        if (qArg) {
          safeSend({
            type: 'actions',
            uiActions: [
              { type: 'navigate', page: 'quests' },
              { type: act, questIdOrTitle: qArg } as JarvisAction,
            ],
          });
        }
        toolResult = { action: act, quest: qArg };
      } else if (name === 'award_skill_practice') {
        const title = asString(args.skillTitle);
        const dom = typeof args.domain === 'string' && VALID_DOMAINS.includes(args.domain as Domain)
          ? (args.domain as Domain)
          : undefined;
        const boost = Math.min(10, Math.max(4, Math.round(Number(args.masteryBoost) || 6)));
        if (title) {
          safeSend({
            type: 'actions',
            uiActions: [
              {
                type: 'award_skill_practice',
                skillTitle: title,
                domain: dom,
                masteryBoost: boost,
              } satisfies JarvisAction,
            ],
          });
        }
        toolResult = { boosted: title, masteryBoost: boost };
      }

      if (liveSession && call.id) {
        liveSession.sendToolResponse({
          functionResponses: [
            {
              id: call.id,
              name,
              response: toolResult,
              scheduling: FunctionResponseScheduling.WHEN_IDLE,
            },
          ],
        });
      }
    };

    const connectToGeminiLive = async () => {
      try {
        const skills = Array.isArray(sessionContext.skills) ? sessionContext.skills : [];
        const quests = Array.isArray(sessionContext.todayQuests) ? sessionContext.todayQuests : [];
        const domainAudit = buildTop1DomainAudit(skills, sessionContext.profile?.domainFocusMinutes);

        const auditText = domainAudit
          .map(
            (r) =>
              `- ${r.domain}: avg ${r.avgMastery}%, Top1% ready ${r.top1ReadyCount}/${r.top1Count}, weakest="${r.weakestSkill?.title || 'None'}" (${r.weakestSkill?.mastery ?? 0}%)`
          )
          .join('\n');

        const activeProjText = sessionContext.activeProject
          ? `Active Project: ${sessionContext.activeProject.projectName} (${sessionContext.activeProject.primaryDomain}) — Goal: ${sessionContext.activeProject.masteryGoal}`
          : 'Active Project: None (Balanced 5-Domain Top 1% Routine)';

        const questsText =
          quests
            .slice(0, 5)
            .map((q, i) => `${i + 1}. [${q.status.toUpperCase()} | ${q.domain}] ${q.title}`)
            .join('\n') || 'None today';

        const skillsCatalog = skills
          .slice(0, 45)
          .map((s) => `- [${s.domain} | ${s.tier} | ${s.mastery}%] ${s.title}`)
          .join('\n');

        const systemInstruction = `You are JARVIS, a Supreme Principal & Distinguished Engineering Voice Mentor inside ApexStack.
GOAL: Hold a crisp, natural, real-time two-way spoken conversation that elevates this Associate Cloud Engineer into the **Top 1%** across all 5 domains (**Angular**, **FastAPI**, **DevOps**, **AWS**, **GCP**).

SUPREME TECHNICAL DEPTH ACROSS ALL 5 DOMAINS:
- Angular: Signals, Zoneless Change Detection, SSR Incremental Hydration (@defer, TransferState, withEventReplay), Web Workers, RxJS backpressure (exhaustMap vs switchMap), takeUntilDestroyed, OIDC PKCE.
- FastAPI: Asyncio non-blocking event-loop discipline, lifespan pools, ACID SELECT ... FOR UPDATE + idempotency keys, zero-lock 3-step Postgres migrations, Redis Lua token buckets, disconnect-aware streaming, OTel traceparent propagation, DuckDB/PyArrow zero-copy S3 profiling.
- DevOps: Kubernetes QoS/cgroups v2/PDBs, preStop + readinessProbe drains, KEDA SQS autoscaling, Argo Workflows & Rollouts canary AnalysisTemplates, blast-radius Terraform + OPA gates, keyless Cosign/SLSA, SLO multi-window burn-rate alerting.
- AWS: Organizations SCPs, IAM intersection math & permission boundaries, EKS Karpenter + VPC CNI /28 prefix delegation, Transit Gateway + PrivateLink zero-NAT egress, S3 multipart CORS ETag, SQS long polling + visibility heartbeats + DLQ, DynamoDB single-table + hot-key salting, RDS Proxy + Aurora Global DR.
- GCP: VPC Service Controls exfiltration perimeters & Shared VPC, Workload Identity Federation, GKE Gateway API + Cloud Armor WAF, Cloud Run concurrency & --no-cpu-throttling, Pub/Sub ackDeadline + DLT idempotency, BigQuery partition filter enforcement + clustering, Cloud Spanner TrueTime.

VOICE COACHING STYLE:
- Speak concisely, directly, and like a live Principal Staff Engineer pairing 1-on-1 (avoid reading out long code symbols verbatim; explain mechanisms crisply and ask focused Socratic follow-up questions!).
- Use your tools asynchronously whenever helpful:
  - Call \`design_domain_roadmap\` if the engineer wants a roadmap designed or upgraded for any domain or all 5 domains.
  - Call \`mark_job_task_done\` if the engineer says they already/priorly completed a job task or finished an active project and wants to resume their normal learning path!
  - Call \`structure_syllabus\` if the engineer asks to structure/optimize their syllabus or target a weak domain.
  - Call \`open_skill_brief\` to pull up their weakest or requested topic side-by-side on screen.
  - Call \`award_skill_practice\` (+4 to +10%) whenever the engineer nails a voice question or gives a sharp architectural explanation!
  - Call \`focus_or_complete_quest\` or \`navigate_workspace\` to drive the UI hands-free.

LIVE WORKSPACE CONTEXT:
Screen: page=${sessionContext.currentScreen?.activePage || 'quests'}, openSkill=${sessionContext.currentScreen?.selectedSkillTitle || 'None'}
${activeProjText}

5-Domain Telemetry:
${auditText}

Today's Quests:
${questsText}

Syllabus Matrix:
${skillsCatalog}`;

        const syncTools: FunctionDeclaration[] = liveTools.map(({ behavior: _b, ...rest }) => rest);

        const attempts: Array<{
          apiVersion: string;
          model: string;
          useThinking: boolean;
        }> = [
          {
            apiVersion: 'v1alpha',
            model: 'gemini-3.8-live-extended-thinking',
            useThinking: true,
          },
          {
            apiVersion: 'v1beta',
            model: 'gemini-3.8-live-extended-thinking',
            useThinking: true,
          },
          {
            apiVersion: 'v1alpha',
            model: 'gemini-3.8-live',
            useThinking: false,
          },
          {
            apiVersion: 'v1beta',
            model: 'gemini-3.8-live',
            useThinking: false,
          },
        ];

        let lastErr: unknown = null;

        for (const attempt of attempts) {
          let setupDone = false;
          try {
            const client = getLiveAiClient(attempt.apiVersion);
            const session = await client.live.connect({
              model: attempt.model,
              config: {
                responseModalities: [Modality.AUDIO],
                ...(attempt.useThinking
                  ? { thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH } }
                  : {}),
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } },
                },
                inputAudioTranscription: {},
                outputAudioTranscription: {},
                tools: [
                  {
                    functionDeclarations: attempt.useThinking ? liveTools : syncTools,
                  },
                ],
                systemInstruction,
              },
              callbacks: {
                onmessage: (message: LiveServerMessage) => {
                  if (isClosing) return;
                  const content = message.serverContent;

                  if (content?.interactionStatus) {
                    lastInteractionStatus = content.interactionStatus;
                    if (content.interactionStatus === InteractionStatus.IN_PROGRESS) {
                      safeSend({ type: 'status', status: 'thinking' });
                    }
                  }

                  if (content?.inputTranscription?.text) {
                    safeSend({ type: 'inputTranscript', text: content.inputTranscription.text });
                  }
                  if (content?.outputTranscription?.text) {
                    safeSend({ type: 'outputTranscript', text: content.outputTranscription.text });
                  }

                  for (const part of content?.modelTurn?.parts ?? []) {
                    if (part.inlineData?.data) {
                      safeSend({ type: 'audio', audio: part.inlineData.data });
                    }
                  }

                  for (const call of message.toolCall?.functionCalls ?? []) {
                    handleLiveToolCall({
                      id: call.id,
                      name: call.name,
                      args: (call.args as Record<string, unknown>) || {},
                    });
                  }

                  if (content?.interrupted) {
                    safeSend({ type: 'interrupted' });
                  }

                  const isIdle = content?.interactionStatus === InteractionStatus.IDLE;
                  const isLegacyTurnDone =
                    Boolean(content?.turnComplete) &&
                    lastInteractionStatus !== InteractionStatus.IN_PROGRESS;

                  if (isIdle || isLegacyTurnDone) {
                    safeSend({ type: 'turnComplete' });
                    safeSend({ type: 'status', status: 'listening' });
                  }
                },
                onerror: (err: unknown) => {
                  if (!setupDone || isClosing) return;
                  console.error('[Live JARVIS session error]:', err);
                  safeSend({
                    type: 'error',
                    message: err instanceof Error ? err.message : 'Live voice stream interrupted.',
                  });
                },
                onclose: () => {
                  if (!setupDone || isClosing) return;
                  if (clientWs.readyState === WebSocket.OPEN) {
                    safeSend({ type: 'status', status: 'disconnected' });
                  }
                },
              },
            });

            setupDone = true;
            liveSession = session;
            break;
          } catch (attemptErr) {
            lastErr = attemptErr;
            console.warn(
              `[Live JARVIS] Attempt ${attempt.model} (${attempt.apiVersion}) failed:`,
              attemptErr instanceof Error ? attemptErr.message : attemptErr
            );
          }
        }

        if (!liveSession) {
          throw lastErr instanceof Error
            ? lastErr
            : new Error('Unable to establish Gemini Live voice connection.');
        }

        safeSend({ type: 'ready' });
      } catch (err) {
        console.error('[Live JARVIS Connect Error]:', err);
        safeSend({
          type: 'error',
          message:
            err instanceof Error
              ? err.message
              : 'Unable to connect real-time Gemini Live voice session.',
        });
      }
    };

    clientWs.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          audio?: string;
          text?: string;
          context?: typeof sessionContext;
        };

        if (msg.type === 'init') {
          sessionContext = msg.context || {};
          if (!liveSession) {
            void connectToGeminiLive();
          }
        } else if (msg.type === 'audio' && msg.audio && liveSession) {
          liveSession.sendRealtimeInput({
            audio: { data: msg.audio, mimeType: 'audio/pcm;rate=16000' },
          });
        } else if (msg.type === 'text' && msg.text && liveSession) {
          liveSession.sendRealtimeInput({ text: msg.text });
        }
      } catch {
        // Ignore malformed client frame
      }
    });

    clientWs.on('close', () => {
      isClosing = true;
      try {
        liveSession?.close();
      } catch {
        // Ignore close errors
      }
      liveSession = null;
    });
  });

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`ApexStack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
