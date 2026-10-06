# Career Outreach Agent

A personal, autonomous job-search and cold-outreach system for **Prince Gupta**.

Every morning it searches public job feeds and company career boards, filters and ranks the
postings against Prince's real profile, finds a legitimate contact, tailors **his own LaTeX
resume** (re-ordering only — never redesigning or inventing), compiles it to PDF, writes a short
cold email in his voice, and puts it in **Gmail Drafts with the PDF attached**. He approves → it
is sent → replies are detected → follow-ups on day 4, 9 and 16 stop the moment someone replies.

```
Profile + LaTeX resume
   ↓  (daily, automatic)
Find jobs: HN "Who is hiring", We Work Remotely, Remotive, Himalayas, Jobicy, Remote OK,
           Arbeitnow + ~40 company boards (Greenhouse / Ashby / Lever public APIs)
   ↓  filters (title, region, age) → dedupe → deterministic 100-pt score → AI only for strong matches
"We found X relevant jobs for you today."
   ↓  top N per day (auto-prepare, never sends)
Contact (published in the posting / company website / Hunter.io) → tailored .tex → PDF
   ↓
Cold email (Prince's voice) → Gmail draft with PDF → you approve → send → track
   ↓
No reply → follow-ups (day 4, 9, 16, your approval)      Reply → all follow-ups cancelled
```

Stack: Next.js (web) → NestJS monolith (API + BullMQ worker) → PostgreSQL (source of truth) +
Redis (cache, locks, rate limits, queues) → TeX Live (in Docker). No microservices.

---

## Quick start (Docker)

```bash
cp .env.example .env     # optional for a first look; required for Gmail / Claude
docker compose up --build
```

Open http://localhost:3000 and create your account (only the first account may register).
**The first job search starts immediately** — the dashboard says
"We found X relevant jobs for you today" within a couple of minutes.

Then, once:

1. **Profile** — check `candidate/candidate-profile.md` (editable in the app). It is the source of
   truth for scoring and writing; anything not in it is never claimed.
2. **Resume** — your LaTeX resume lives in `candidate/resume.tex` and is used automatically as the
   template (or use *Upload .tex* on the Resume page, plus any `.cls/.sty/fonts`). It must compile;
   the page shows the TeX log if it doesn't.
3. **Settings → Connect Gmail** (see below) and set `EMAIL_PROVIDER=gmail`.
4. Optional: Claude for better analysis/writing (`AI_PROVIDER=anthropic`).

Daily use: open the dashboard → pick a job → check match, contact, tailored PDF and email →
**Approve & send** (or send the draft from Gmail — the app notices and starts tracking).

Ports are bound to localhost: web `3000`, API `4000`, Postgres `5433`, Redis `6380`.
The API/worker image includes TeX Live with `texlive-fonts-extra` (~1 GB; build with
`--build-arg TEX_FONTS_EXTRA=false` for a smaller image if your template doesn't need it).

## Local development (without Docker for the apps)

Node 20.12+ (22 recommended), PostgreSQL 14+, Redis 6+, and TeX Live/MacTeX if you want PDF
compilation locally (`brew install --cask mactex-no-gui`).

```bash
npm install
cp .env.example .env && ln -s ../../.env apps/api/.env     # edit DATABASE_URL / REDIS_URL / secrets
npm run db:deploy && npm run db:seed
npm run dev:api      # :4000
npm run dev:worker   # BullMQ workers + schedules
npm run dev:web      # :3000
```

Or run only infrastructure in Docker: `docker compose up -d postgres redis` and point `.env` at
`postgresql://jobhunter:jobhunter@localhost:5433/job_hunter` and `redis://localhost:6380/0`.

## Job discovery

Sources are seeded automatically on sign-up (Settings → *Job discovery sources* to disable or add):

| Source | How | Notes |
| --- | --- | --- |
| Hacker News "Who is hiring?" | Algolia public API | Startups; posters often publish their own email (stored as a verified contact) |
| We Work Remotely | public RSS | company website extracted → contact lookup |
| Remotive, Himalayas, Jobicy, Remote OK, Arbeitnow | public JSON APIs | remote roles; attribution links kept |
| ~40 company boards | Greenhouse / Ashby / Lever public job-board APIs | verified to list India-based or globally-remote backend roles (Okta, MongoDB, Stripe, Coinbase, Databricks, GitLab, Sarvam AI, Plane, Supabase, ClickHouse, …) |

Add any company: Settings → board token (`boards.greenhouse.io/<token>`, `jobs.ashbyhq.com/<token>`,
`jobs.lever.co/<token>`). Single jobs can still be added by URL or pasted JD (optional).

**Pipeline (no LLM until the end):** listed postings → title keywords + exclusions (e.g. frontend,
manager, other primary languages) → region (remote jobs restricted to US/EU/UK are dropped;
India/APAC/worldwide kept) → age (≤ 30 days) → dedupe (source id + content hash, across sources and
days) → deterministic score → only STRONG APPLY / APPLY ≥ threshold go to the LLM. Greenhouse boards
are listed without descriptions; full text is fetched only for postings that pass the filters.
A live dry-run on Oct 6, 2026: 3,535 postings listed → 57 after filters → 18 worth applying to.

Schedule: daily at 07:00 IST (`DISCOVERY_CRON=30 1 * * *`, container time is UTC), on first
worker start, on sign-up, and on **Find jobs now**.

> **Network note.** Some networks (corporate firewalls, antivirus "HTTPS scanning") intercept job
> sites. The app detects this and shows *"Blocked by your network …"* on the affected sources
> instead of failing silently. On the network this was built on, a Sophos firewall intercepted
> Remotive, Himalayas, Jobicy, Remote OK, Arbeitnow and Lever; HN, We Work Remotely, Greenhouse and
> Ashby worked. Run it on a home network to use every source. Certificate checks are never disabled.

## Your LaTeX resume

- `candidate/resume.tex` (next to the profile) becomes the template automatically the first time the
  resume is used — no upload needed. Uploading a `.tex` on the Resume page replaces it; after
  *Remove LaTeX* the file is not re-imported.
- Or upload the `.tex` (and any `.cls/.sty/.bib/fonts/images`) on the Resume page. Engine is detected
  (`% !TEX program = xelatex`, `fontspec` → XeLaTeX; otherwise pdfLaTeX).
- **Tailoring never redesigns.** The parser works on the document body only (preamble and comments
  untouched) and makes three kinds of change:
  1. re-orders bullets inside each Experience/Projects/Production Challenges list (most JD-relevant
     first) — `\item` and custom item macros such as `\itemx{…}` / `\resumeItem{…}`,
  2. re-orders items inside comma-separated skills lines ("Languages: …"); groups in parentheses
     ("AWS (EC2, S3)") stay together and a trailing "; …" clause stays at the end,
  3. with Claude enabled: rephrases *plain-text* bullets toward the JD's wording — each rewrite must
     pass a truth guard (no new technologies, numbers, metrics or "led/owned/architected"), and
     bullets containing LaTeX formatting are never touched.
  Nothing is added or removed; the tailored file has the same length as the original.
- The job page shows the exact `.tex` diff, a **Download PDF** button and the `.tex`.
- Compilation runs without shell-escape, with TeX file access restricted to a throw-away directory,
  a 60 s timeout and limited concurrency. If a tailored file doesn't compile, the app refuses to
  substitute a different design.

Without a LaTeX upload, a clean built-in PDF layout is generated from the structured resume.

## Gmail

OAuth only — the app never asks for your Gmail password; tokens are AES-256-GCM encrypted.

1. https://console.cloud.google.com → new project → enable **Gmail API**.
2. **OAuth consent screen / Google Auth Platform**: External; scopes `gmail.compose`,
   `gmail.readonly`; **add your Gmail address under Test users** (otherwise Google shows
   "Access blocked … has not completed the Google verification process").
3. **Credentials → OAuth client ID → Web application**, redirect URI
   `http://localhost:3000/api/email/gmail/callback`.
4. `.env`: `EMAIL_PROVIDER=gmail`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
   `GOOGLE_REDIRECT_URI`; restart (`docker compose up -d --force-recreate api worker`).
5. Settings → **Connect Gmail** → on "Google hasn't verified this app" choose *Continue*.

In testing mode Google expires the connection after 7 days (reconnect, or *Publish app*).

**Drafts.** Every prepared email (and follow-up) is mirrored into Gmail Drafts with the tailored
PDF attached and kept in sync with your edits. *Approve & send* sends that draft (after re-checking
daily limits, cooldowns, suppression list). If you send a draft yourself from Gmail, the next sync
(every 10 min, or *Check for replies*) records it and schedules follow-ups. Cancelled follow-ups
have their drafts deleted so they can't be sent by accident.

## Follow-ups and replies

Default: day **4, 9 and 16** after the first email (anchored to the first email; moved into your
send window and off weekends). #1 is a short reminder, #2 adds one new piece of real context, #3
closes the loop. Drafts are prepared a day early and wait for your approval (or enable auto-send).
Replies are checked every 10 minutes **and immediately before any follow-up is sent**; a reply
cancels everything pending. Out-of-office auto-replies don't; bounces do (and suppress the
address); "please stop" replies are suppressed automatically. Adding an interview also stops them.

## Contacts

Only legitimate, published sources — email addresses are never guessed:

1. addresses in the posting itself (HN posts, "send your CV to …"),
2. hiring inboxes published on the company's own website (`careers@`, `jobs@`, … on its domain;
   personal addresses on the site are ignored),
3. Hunter.io domain search (optional, `HUNTER_API_KEY`, free tier available).

Each contact has a source and confidence. When none is found, the job page links to LinkedIn
people searches (engineering manager / recruiter / CTO at that company) so you can add one.
Ranking depends on company size (founder/CTO first at early startups; hiring manager / technical
recruiter first at large companies).

## AI and cost

Works fully without an LLM (`AI_PROVIDER=template`): scoring, tailoring and emails are
deterministic and grounded in the profile. With `AI_PROVIDER=anthropic` (`ANTHROPIC_API_KEY`,
default model `claude-opus-5-5`; `claude-sonnet-5-5` is cheaper) Claude is used only for:
semantic analysis of strong matches, bullet rephrasing (guarded), and email/follow-up writing
(validated: banned phrases, 80–150 words, no technologies outside profile/JD, no invented
metrics; one retry, then deterministic fallback). Every result is cached by input hash in
`ai_generations`; the same JD + profile is never analysed twice. Settings → System health shows
calls, latency and tokens.

## Environment variables

See `.env.example`. Key ones: `DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `ENCRYPTION_KEY`
(generated automatically in Docker if absent), `APP_URL`, `EMAIL_PROVIDER` (`sandbox`|`gmail`),
`GOOGLE_*`, `AI_PROVIDER`, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `HUNTER_API_KEY`,
`DISCOVERY_CRON`, `EMAIL_SYNC_CRON`, `FOLLOWUP_CRON`, `CANDIDATE_PROFILE_PATH`.

Sandbox mode (`EMAIL_PROVIDER=sandbox`, the default) keeps a local mailbox in Redis: nothing is
sent, and sent emails get *Simulate reply / out-of-office / bounce* buttons.

## Database

PostgreSQL schema in `apps/api/prisma/schema.prisma`: users, profiles, resumes (incl. LaTeX source
and compiled PDF), resume_versions (tailored .tex + PDF), companies, jobs, contacts, applications,
outreach (incl. Gmail draft ids), followups, interviews, discovery_runs, email_accounts,
email_events, ai_generations, job_sources, audit_logs, suppressions.
`npm run db:deploy` applies migrations (Docker does it on start); `npm run db:migrate -- --name x`
creates one; `npm run db:seed` mirrors the profile (+ `SEED_DEMO=true` for demo jobs).

## Tests

```bash
npm test                    # unit (no services)
npm run test:integration    # PostgreSQL + Redis + BullMQ + Gmail REST + discovery (mocked internet)
npm run test:e2e            # full workflows over HTTP
```

Integration/e2e use `job_hunter_test` and Redis DB 15 (`TEST_DATABASE_URL`, `TEST_REDIS_URL`).
Covered: scoring, extraction, dedupe, region/title filters, all feed parsers, LaTeX parsing +
design-preserving tailoring + truth guard, follow-up scheduling/cancellation, guardrails, rate
limiting, state machine, Gmail REST + OAuth + token encryption, BullMQ dedupe/defer/retry,
discovery → auto-prepare → Gmail drafts, and the acceptance flow
"We found X jobs today → job → match → contact → tailored PDF → email → approve → send (draft) →
follow-up → reply → follow-ups + their drafts cancelled → interview", plus "draft sent from Gmail
is detected". LaTeX *compilation* is exercised in tests only where a TeX engine is installed (the
Docker image); elsewhere the tests assert that the app refuses to fall back to another design.

## Security

OAuth with encrypted tokens; HttpOnly SameSite session cookie; double-submit CSRF; OAuth state bound
to the user; Redis rate limiting; Zod validation; private-network URL blocking; robots.txt respected;
LaTeX compiled without shell-escape in a sandboxed directory; audit log; structured JSON logs with
correlation ids (tokens, cookies, passwords and email bodies redacted).

## Project layout

```
candidate/candidate-profile.md   Canonical candidate profile
apps/api/src/domain/             Pure logic: scoring, extraction, filters, LaTeX parse/tailor,
                                 truth guard, guardrails, follow-up schedule, state machine
apps/api/src/providers/          Job feeds & boards, contacts, Gmail/sandbox, Claude/template AI,
                                 LaTeX compiler, PDF renderer, resume parser
apps/api/src/modules/            Services/controllers, discovery orchestrator, BullMQ processors
apps/api/test/                   Integration + e2e tests (mocked internet)
apps/web/                        Next.js UI
docker-compose.yml               postgres, redis, api, worker, web
```
