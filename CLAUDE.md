# Job-hunter — project context

Personal career-outreach app for one user (Prince Gupta, Senior Backend Engineer, India). It finds the latest jobs and scores them against his profile. **Nothing is ever sent or applied without his explicit approval.**

## Stack and layout (simplified Nov 2026, branch `simplify`)

No database, no Redis/BullMQ, no worker, no auth, no AI. Single user, runs locally.

- `apps/api` — plain Node `http` server (`src/main.ts`), one route `GET /api/jobs/search?days=N`. `src/search.ts` runs all sources (a few at a time, inside the request), filters, scores, dedupes and returns JSON. `npm run fetch` does the same from the terminal.
- `apps/web` — Next.js 15, one page (`app/page.tsx`). State lives in browser localStorage (`lib/store.ts`): jobs by stable id, status new/applied/skipped, first-seen time.
- `candidate/` — `candidate-profile.md` (facts about the user; **he edits it, never edit it**).
- `apps/api/src/startups.ts` — YC dataset startups (default 50–100 people, India/remote, hiring) → verified Greenhouse/Ashby/Lever boards, cached 14 days in `apps/api/.cache/startup-boards.json`.
- `apps/api/src/browser/` — job boards via the user's own logged-in Chrome (Playwright `channel: 'chrome'`, persistent profile `~/.job-hunter/chrome-profile`). `npm run login -- <site>`; `npm run fetch -- 7 --sites=default|a,b [--snapshot]`. Read-only, 3–7 s between pages, ≤15 job pages per site. Parses schema.org JobPosting ld+json. LinkedIn/Naukri only when named explicitly. Never store passwords; never use `ignoreHTTPSErrors`.
- `apps/api/src/apply/` — auto-apply on Naukri, Hirist, Instahyre (`engine.ts`, one config per site). `npm run daily` = search + save + apply; `npm run apply`; `npm run answers`. Per-site switch `~/.job-hunter/settings.json` (off / dry-run / on; default dry-run; "on" is his approval). Guardrails that must stay: daily limit 30, never re-apply (`apps/api/.cache/applied.json`), visible Chrome, 20–40 s between applications, company-site jobs skipped. Answers from `~/.job-hunter/answers.json` (bank from profile + FACTS; his own entries — no source or "you" — always win); never answer gender/DOB/disability; never claim years in a non-strong skill; unknown questions go to `unanswered-questions.json`. Tests must never write his real files (paths are read lazily from env).
- Shared results: every search (CLI or dashboard) merges into `apps/api/.cache/results.json`; dashboard reads `GET /api/jobs`.
- Sources (Nov 2026, his choice): company career sites only (Greenhouse/Lever/Ashby lists in `default-sources.ts`, Workday in `providers/jobs/workday.ts`), YC startups 50–100 (`startups.ts`), Indian product companies (`india-companies.ts`, boards found at run time), and browser sites Wellfound/Hirist/Instahyre/Naukri/LinkedIn/Indeed. Public feeds (HN, WWR, Remotive, Himalayas, Jobicy, Remote OK, Arbeitnow) were removed on purpose; do not re-add.
- Kept pure code: `providers/jobs` (Greenhouse/Lever/Ashby/Workday), `domain/matching`, `domain/skills`, `domain/profile`, `domain/dedupe`.
- Old full app (DB, queues, resume tailoring, outreach, Gmail alerts) is on `main` and in `git stash` "WIP before simplify".

## Commands

```
npm run dev:api | dev:web
npm run fetch -- 7           # terminal search, writes apps/api/jobs.json
npm run test && npm run lint && npm run typecheck
```

## Gotchas

- Claude's Bash sandbox intercepts HTTPS to many hosts (Lever, Remotive, Naukri, LinkedIn...). Failures seen from the sandbox are not the user's network; he runs live fetches in his own terminal.
- Known unrelated failing test was `email.spec.ts`; it was removed with the email module.

## Working rules

- Match surrounding code style and comment density. Keep changes small and focused; additive over rewrites.
- Don't change discovery or scoring unless the task asks for it.
- Add tests with every change (unit for domain, integration/e2e for flows). Run typecheck, lint and the relevant tests before saying it is done, and report failures honestly.
- Never send email, apply to a job, or contact anyone without explicit approval. No unauthorized scrapers (use public APIs/feeds).
- Follow `~/.claude/CLAUDE.md`: simple English, answer first, explain the why, work one milestone at a time when teaching.

## Status

Milestones 1 (simplify), 2 (age window on all sources, title excludes, 50–100 startups) done. Milestone 3 code done; site URL patterns/link regexes need checking against his first `--snapshot` run. Next: (3b) tune per site, (3c) LinkedIn/Naukri/Wellfound/Hirist/Instahyre via a user-logged-in Playwright session (read-only, low volume, never a stored password), (4) recruiter/engineering-manager contacts: public LinkedIn profile links + only published or verified emails.
