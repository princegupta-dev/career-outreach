# Career Outreach Agent

**A self-hosted job-search assistant that finds relevant jobs every morning, tailors your own LaTeX
resume for each one, and drafts an honest cold email in Gmail — you just review and hit send.**

It runs entirely on your machine with Docker. It works with **no API keys at all** (sandbox email +
deterministic writer), and gets better if you add Gmail and Claude.

![Dashboard](docs/screenshots/dashboard.png)

## What it does

Every day, automatically:

1. **Finds jobs** from public feeds and company career boards — Hacker News "Who is hiring", We Work
   Remotely, Remotive, Himalayas, Jobicy, Remote OK, Arbeitnow, and ~40 company boards (Greenhouse,
   Ashby, Lever). Thousands of postings are filtered down to the few that fit you.
2. **Scores each job** against your profile with a transparent 100-point score (skills, seniority,
   role, location, …). No LLM needed; AI is only used for the strongest matches, if enabled.
3. **Finds a real contact** — only published addresses (in the posting, on the company site, or via
   Hunter.io). Emails are never guessed.
4. **Tailors your resume** — re-orders bullets and skills in *your own* `.tex` file to put the most
   relevant things first, then compiles it to PDF. Your design is never changed, and nothing is
   invented.
5. **Writes a short cold email** grounded only in facts from your profile, and puts it in **Gmail
   Drafts with the PDF attached**.
6. **You approve → it sends → it tracks replies.** If nobody answers, it prepares follow-ups on day
   4, 9 and 16. The moment someone replies, all follow-ups stop.

```
Your profile + LaTeX resume
   ↓  daily, automatic
Find jobs → filter (title, region, age) → dedupe → score → (optional) AI analysis for strong matches
   ↓
Contact → tailored .tex → PDF → cold email → Gmail draft
   ↓
You approve → send → no reply: follow-ups (day 4, 9, 16) | reply: follow-ups cancelled
```

**Honesty is built in.** A "truth guard" rejects any generated text that claims a skill, number or
title that is not in your profile. Banned phrases ("I hope this email finds you well", "thrilled",
"proven track record", …) are blocked.

## Screenshots

| Jobs found today | One job: score, contact, tailored PDF, email |
| --- | --- |
| ![Jobs](docs/screenshots/jobs.png) | ![Job detail](docs/screenshots/job-detail.png) |

| Outreach pipeline | Resume (LaTeX template) |
| --- | --- |
| ![Outreach](docs/screenshots/outreach.png) | ![Resume](docs/screenshots/resume.png) |

## Responsible use

This tool is for writing **a few thoughtful emails a day**, not mass mailing. Daily send limits,
per-company and per-recipient cooldowns, a suppression list (bounces and "please stop" replies) and
a send window are on by default — please keep them that way. Every first email needs your approval.

## Who it's for

Out of the box it is tuned for **software engineers** (the default search, skill taxonomy and title
filters are engineering-focused). Within that, you control it through your profile: target roles,
locations, skills. Frontend, backend, full-stack, platform, staff — any role you list in
`target_roles` is searched for.

---

## Getting started

### 1. Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose v2)
- ~5 GB free disk (the API image includes TeX Live to compile LaTeX)
- Git

That's it for the Docker setup — no Node, Postgres or LaTeX on your machine.

### 2. Clone and configure

```bash
git clone https://github.com/princegupta-dev/career-outreach.git
cd career-outreach
cp .env.example .env
```

For a first look, you don't need to edit `.env` — the defaults run in **sandbox mode** (nothing is
ever sent; you can simulate replies) with the **template writer** (no AI, zero cost).

Before using it for real, set two secrets in `.env`:

```bash
# paste each output into .env
openssl rand -hex 32   # → SESSION_SECRET
openssl rand -hex 32   # → ENCRYPTION_KEY
```

### 3. Put in your own profile and resume

The `candidate/` folder holds **the author's** profile and resume as an example. Replace them:

- `candidate/candidate-profile.md` — your roles, locations and skills (**required**)
- `candidate/resume.tex` — your LaTeX resume (optional; delete it to use a built-in PDF layout)

See [candidate/README.md](candidate/README.md) for what each field does.

### 4. Start it

```bash
docker compose up --build
```

The first build takes 5–15 minutes (mostly TeX Live). For a smaller image, if your resume doesn't
need extra fonts:

```bash
docker compose build --build-arg TEX_FONTS_EXTRA=false && docker compose up
```

When you see the web container is ready, open **http://localhost:3000** and **create your
account** (only the first account can register — this is a single-user app).

The first job search starts right away. Within a couple of minutes the dashboard shows
*"We found X relevant jobs for you today."*

### 5. Daily use

Open the dashboard → pick a job → check the match, contact, tailored PDF and email → **Approve &
send** (or send the draft from Gmail directly — the app notices and starts tracking it).

### 6. Optional upgrades

| Want | Do this |
| --- | --- |
| Real emails via Gmail | Follow [Gmail setup](#gmail) below, then `EMAIL_PROVIDER=gmail` |
| Better analysis & writing with Claude | `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=...` ([get a key](https://console.anthropic.com)) |
| More contacts found | `HUNTER_API_KEY=...` ([Hunter.io](https://hunter.io), free tier) |
| Different search time | `DISCOVERY_CRON` (default `30 1 * * *` = 07:00 IST; container time is UTC) |

After editing `.env`, restart: `docker compose up -d --force-recreate api worker`.

### Useful commands

```bash
docker compose up -d                  # start in the background
docker compose logs -f api worker     # follow logs
docker compose down                   # stop (data is kept in Docker volumes)
docker compose down -v                # stop and DELETE all data
```

Ports (localhost only): web `3000`, API `4000`, Postgres `5433`, Redis `6380`.

### Troubleshooting

- **Port already in use** — stop whatever is using 3000/4000/5433/6380, or change the left side
  of the `ports:` mappings in `docker-compose.yml`.
- **"Blocked by your network"** on some sources — a firewall/antivirus is intercepting HTTPS. See
  the network note under [Job discovery](#job-discovery).
- **Resume doesn't compile** — the Resume page shows the TeX log. Upload any missing
  `.cls`/`.sty`/font files there too.
- **Gmail says "Access blocked"** — add your Gmail address under *Test users* (step 2 of
  [Gmail](#gmail)).
- **Profile errors** — open the Profile page; it shows exactly which field is invalid.

---

## Local development (without Docker for the apps)

Node 20.12+ (22 recommended), PostgreSQL 14+, Redis 6+, and TeX Live/MacTeX if you want PDF
compilation locally (`brew install --cask mactex-no-gui`).

```bash
npm install
npm run db:generate                                          # generate the Prisma client
cp .env.example .env && ln -s ../../.env apps/api/.env       # edit DATABASE_URL / REDIS_URL / secrets
npm run db:deploy && npm run db:seed
npm run dev:api      # :4000
npm run dev:worker   # BullMQ workers + schedules
npm run dev:web      # :3000
```

Or run only infrastructure in Docker: `docker compose up -d postgres redis` and point `.env` at
`postgresql://jobhunter:jobhunter@localhost:5433/job_hunter` and `redis://localhost:6380/0`.

Stack: Next.js (web) → NestJS monolith (API + BullMQ worker) → PostgreSQL (source of truth) +
Redis (cache, locks, rate limits, queues) → TeX Live. No microservices.

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
A fresh install on Oct 25, 2026 (46 sources, no API keys): 7,466 postings listed → 78 after
filters → 31 relevant → 5 prepared automatically (tailored PDF compiled), with zero errors.

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
