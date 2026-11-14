# ApexStack

An intelligent **Top 1% Engineering Mastery Console** built for Associate Cloud Engineers advancing across five core production domains: **Angular**, **FastAPI**, **DevOps**, **AWS**, and **GCP**.

ApexStack combines a real-time AI mentor (**JARVIS**), two-way live voice coaching, `roadmap.sh`-style interactive skill blueprints, automatic daily quest orchestration, project-override mission tracking, and SM-2 spaced repetition in a unified workspace backed by Firebase Authentication and Cloud Firestore.

---

## Key Features

### 1. Daily Quests (`Quests`)
- Automatically issues ranked daily engineering quests (`E-Rank` to `S-Rank`) across four categories: **Project Execution**, **Domain Mastery**, **Production Drill**, and **Active Recall**.
- Operates in two automatic modes:
  - **Normal Routine**: Follows your calibrated 7-day domain rotation budget.
  - **Project Override**: Temporarily focuses daily execution around an active uploaded work ticket or project until completion.
- Completing a quest atomically awards XP, updates linked skill mastery in Firestore, checks milestone unlocks, and synchronizes matching roadmap steps.

### 2. Interactive Roadmaps & Unified Master Sequence (`Roadmaps`)
- **Unified Master Sequence (`All`)**: Combines all five domains into one continuous `roadmap.sh`-style progression graph and detailed checklist with two traversal orders:
  - **Stack Order (`1→5`)**: Sequential progression through `Angular → FastAPI → DevOps → AWS → GCP`.
  - **Tier Lockstep**: Cross-domain lockstep progression from `Foundational → Senior → Top 1%`.
- **Per-Domain JARVIS Blueprints**: Custom multi-stage roadmaps for each domain featuring detailed engineering guides, common production pitfalls, deliverables, and hands-on lab objectives.
- **Live Curriculum Fallback & Sync**: Any domain without a custom JARVIS blueprint automatically projects its seeded curriculum nodes so the combined sequence stays complete.
- **Job Task Completion & Path Resumption**: Mark real-world job tasks complete directly from the roadmap or via JARVIS (`Mark Done & Resume`) to log XP, advance skill mastery, tick off matching roadmap steps, and resume your normal study rotation.

### 3. Project & Work Task Mapper (`Upload Task`)
- Paste a real engineering ticket, architecture brief, or project spec.
- Maps the brief into concrete domain competencies, provides Staff-level elevation advice, generates a **Project Mission** with a Master Syllabus, and switches daily quests into Project Override mode.

### 4. Profile, Skill Matrix & Active Recall (`Profile`)
- Tracks engineer levels per domain and overall, weekly study targets, streaks, rotation schedule, and unlocked milestones.
- Browse skill nodes across **Foundational**, **Senior**, and **Top 1%** tiers, open deep-dive study briefs with lab prompts, and launch the **Active Recall Drawer** powered by SM-2 spaced repetition.

### 5. JARVIS AI Mentor & Live Voice Console
- Persistent right-hand command mentor with structured, easy-to-scan responses, copyable code snippets, and suggested follow-up prompts.
- Executes live workspace actions directly from conversation (navigating views, designing roadmaps, structuring the syllabus, boosting skill mastery, and refreshing or completing quests).
- **Real-Time Voice Mode**: Supports two-way live audio coaching over WebSockets in addition to microphone dictation and spoken playback.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons, Motion, Vite
- **Backend & WebSockets**: Node.js, Express, `ws` (`server.ts` serving both API/WebSocket routes and the Vite client on port `3000`)
- **AI Integration**: `@google/genai` (server-side REST endpoints + Gemini Live Audio WebSocket proxy)
- **Database & Auth**: Firebase Authentication & Cloud Firestore

---

## Project Structure

```text
├── server.ts                  # Express server, AI endpoints, Live Voice WebSocket bridge, Vite middleware
├── firebase-applet-config.json# Firebase client & database configuration
├── firebase-blueprint.json    # Firestore entity schemas and collection definitions
├── firestore.rules            # User-scoped Firestore security rules
├── index.html                 # Application HTML entry point
├── package.json               # Scripts and dependencies
└── src/
    ├── App.tsx                # Workspace orchestration, subscriptions, JARVIS action router
    ├── main.tsx               # React entry point
    ├── index.css              # Tailwind CSS entry
    ├── types/
    │   └── learning.ts        # Shared TypeScript interfaces for quests, roadmaps, skills, and JARVIS
    ├── data/
    │   ├── seedCurriculum.ts  # 5-domain Top 1% baseline curriculum and rotation defaults
    │   └── milestones.ts      # Domain/overall leveling & milestone computation
    ├── lib/
    │   ├── firebase.ts        # Firebase app, Auth, and Firestore initialization
    │   ├── firestoreService.ts# Firestore subscriptions and atomic persistence helpers
    │   ├── aiClient.ts        # Client wrappers for backend AI endpoints
    │   └── liveVoiceClient.ts # WebSocket audio streaming client for JARVIS voice mode
    └── components/
        ├── AuthGate.tsx       # Firebase Authentication sign-in gate
        ├── CalibrationView.tsx# Initial weekly hours & rotation calibration
        ├── QuestsPage.tsx     # Daily Quests view & completion workflow
        ├── RoadmapsPage.tsx   # Unified Sequence & per-domain roadmap.sh graph/list UI
        ├── UploadTaskPage.tsx # Project/ticket analyzer & mission activation
        ├── ProfilePage.tsx    # Domain levels, skill matrix, study briefs & milestones
        ├── ActiveRecallDrawer.tsx # SM-2 spaced-repetition flashcard reviewer
        ├── JarvisConsole.tsx  # Persistent JARVIS chat & live voice mentor drawer
        └── CelebrationOverlay.tsx # Quest/project/milestone completion feedback
```

---

## Getting Started

### Prerequisites
- **Node.js** `>= 22.14.0`
- A **Gemini API Key** (`GEMINI_API_KEY`)
- A **Firebase project** with Authentication and Cloud Firestore enabled (configured in `firebase-applet-config.json`)

### Environment Variables
Copy `.env.example` to `.env` and configure the required variables:

```env
GEMINI_API_KEY="YOUR_GEMINI_API_KEY"
APP_URL="http://localhost:3000"
```

### Install & Run

```bash
# Install dependencies
npm install

# Start the development server (Express + Vite + WebSocket on port 3000)
npm run dev
```

### Build & Type Check

```bash
# Run TypeScript type check
npm run lint

# Build production frontend bundle
npm run build
```

---

## Backend API Endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Server health check |
| `POST /api/ai/system-daily-quests` | Generate daily ranked quests from rotation or active mission |
| `POST /api/ai/system-upload-project` | Analyze project brief into a Master Syllabus and override quests |
| `POST /api/ai/design-roadmap` | Design or refine a domain's multi-stage `roadmap.sh` blueprint |
| `POST /api/ai/jarvis` | Conversational mentoring and structured UI command actions |
| `POST /api/ai/map-work-log` | Extract skills and Staff-level elevation notes from a work log |
| `POST /api/ai/generate-brief` | Generate deep-dive study briefs and lab prompts for skills |
| `POST /api/ai/generate-quiz` | Generate SM-2 active-recall flashcards |
| `POST /api/ai/analyze-gaps` | Analyze skill mastery gaps across domains |
| `POST /api/ai/adapt-syllabus` | Re-prioritize syllabus modules for active work |
| `POST /api/ai/syllabus-agent` | Conversational syllabus adaptation planning |
| `POST /api/ai/drill-step` | Multi-turn production incident drill evaluation |
| `WS /api/live-jarvis` | Real-time bidirectional voice streaming bridge for JARVIS |
