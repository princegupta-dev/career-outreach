# Job-hunter — project context

Personal career-outreach app for one user (Prince Gupta, Senior Backend Engineer, India). It finds jobs, scores them against his profile, helps prepare an application (tailored resume + email drafts), and tracks follow-ups. **Nothing is ever sent or applied without his explicit approval.**

## Stack and layout

Monorepo (npm workspaces), Node 20.12 pinned.

- `apps/api` — NestJS + Prisma 6 (PostgreSQL) + BullMQ (Redis). Separate API process and worker process.
- `apps/web` — Next.js 15, SWR, Tailwind.
- `candidate/` — `candidate-profile.md` (facts about the user; **he edits it, never edit it**) and `resume.tex` (resume content master).
- Ports: web 3000, API 4000.

API code map (`apps/api/src`):
- `domain/` — pure logic, no I/O: matching/scoring, applications (state machine, `lifecycle.ts`), preparation steps, resume (`tailor.ts`, `resume-document.ts`), latex parsing, email checks, dedupe, company size.
- `modules/` — Nest services/controllers: jobs, discovery (+ `directory.service.ts`), applications, preparation (workflow), resume, outreach, followups, ai, queues, profile, settings.
- `providers/` — external edges: `jobs/` (Greenhouse/Ashby/Lever ATS, aggregators, default sources), `ai/` (anthropic, ollama, template), `documents/` (HTML→PDF), `email/`, `contacts/`.

## How things work (decisions already made)

- **Discovery**: hard eligibility filters vs soft flags. Location is classified by whitelist (india / global / unspecified / restricted). Sources: ATS board probing, aggregators, YC directory dataset. Rejections keep reason codes. Discovery and scoring are deterministic and run before any AI.
- **Application lifecycle**: additive statuses (never break old ones). "Prepare my application" runs a `PreparationWorkflow` (per-step state, events, compare-and-set claim, heartbeat) on the `job-processing` queue. Each step is attempted once per run.
- **Resume**: LaTeX source is the content master. Tailoring only re-orders bullets/skills (truth guard; optional AI rephrase). The PDF is drawn from an HTML template with Playwright Chromium (no pdflatex). The PDF is validated (text selectable, all content present, page count). "Gaps" are measured against the resume body text, not the profile.
- **AI layer**: `AiService.run` is the single entry point: cache by input hash, circuit breaker, fallback to the deterministic template provider. Providers: `template` (default), `ollama` (free, local, JSON-schema output), `anthropic`. Use `provider.model`, not env vars. Errors that are fixable in a minute (e.g. Ollama model not pulled) must be `retryable: true`, or the 30-minute circuit opens. Check with `npm run ai:check` or Settings → "Test AI connection".
- **Email**: `EMAIL_PROVIDER=sandbox` by default (stored locally, never sent). Gmail only when he opts in. Never invent contact emails.

## Commands

```
npm run dev:api | dev:worker | dev:web
npm run test                 # unit
npm run test:integration     # needs job_hunter_test DB + Redis DB 15, runs --runInBand
npm run test:e2e
npm run lint && npm run typecheck
npm run db:migrate | db:deploy | db:seed
npm run ai:check
```

## Gotchas

- After any Prisma schema change, **restart `dev:worker`**; its watcher keeps stale types.
- jest can hang with watchman; use `--runInBand`/no watch for integration.
- Migrations must be additive.
- Known unrelated failing unit tests: `email.spec.ts` (voice check flags "CloudWatch") and `policies.spec.ts` (hardcodes `india_min_lpa` 30 while the profile says 16). Do not "fix" by editing his profile.
- Dev API/worker are run in sandbox mode: `EMAIL_PROVIDER=sandbox`. Don't override `AI_PROVIDER` on the command line; it beats `.env`.

## Working rules

- Match surrounding code style and comment density. Keep changes small and focused; additive over rewrites.
- Don't change discovery or scoring unless the task asks for it.
- Add tests with every change (unit for domain, integration/e2e for flows). Run typecheck, lint and the relevant tests before saying it is done, and report failures honestly.
- Never send email, apply to a job, or contact anyone without explicit approval. No unauthorized scrapers (use public APIs/feeds).
- Follow `~/.claude/CLAUDE.md`: simple English, answer first, explain the why, work one milestone at a time when teaching.

## Status

Resume tailoring with AI: `tailorLatex` can rephrase the plain-text Summary and bullets (truth guard on both) and add skills the user ticked on the job page (`confirmedSkills`, remembered per job). The model never picks skills. The 3B Ollama model mostly copies text back; `qwen2.5:7b` is the better choice.

Done: discovery hardening and expansion, simplified job detail page + prepare workflow, Chromium PDF resumes, accurate resume gaps, Ollama provider.

Awaiting his decision (do not start unprompted): multi-source expansion plan (Common Crawl company discovery, Gmail alert-email ingestion, Hirist, Hunter API key, ranking/observability phases).
