# Career Outreach Agent

**A self-hosted job-search assistant that finds relevant jobs every morning, tailors your resume for
each one, and drafts an honest cold email in Gmail — you just review and hit send.**

It runs entirely on your machine with Docker. It works with **no API keys at all** (sandbox email +
deterministic writer), and gets better if you add Gmail and an AI model (free local Ollama, or Claude).

![Dashboard](docs/screenshots/dashboard.png)

## What it does

Every day, automatically:

1. **Finds jobs** from public feeds and company career boards — Hacker News "Who is hiring", We Work
   Remotely, Remotive, Himalayas, Jobicy, Remote OK, Arbeitnow, and company boards (Greenhouse,
   Ashby, Lever). Thousands of postings are filtered down to the few that fit you.
2. **Scores each job** against your profile with a transparent 100-point score (skills, seniority,
   role, location, …). No LLM needed; AI is only used for the strongest matches, if enabled.
3. **Finds a real contact** — only published addresses (in the posting, on the company site, or via
   Hunter.io). Emails are never guessed.
4. **Tailors your resume** — re-orders the bullets and skills from your `resume.tex` so the most
   relevant things come first, then builds a clean, ATS-friendly PDF. Nothing is invented.
5. **Writes a short cold email** grounded only in facts from your profile, and puts it in **Gmail
   Drafts with the PDF attached**.
6. **You approve → it sends → it tracks replies.** If nobody answers, it prepares follow-ups on day
   4, 9 and 16. The moment someone replies, all follow-ups stop.

```
Your profile + resume.tex
   ↓  daily, automatic
Find jobs → filter (role, region, age) → dedupe → score → (optional) AI analysis for strong matches
   ↓
"Prepare my application": check job → research company → contact → tailored PDF → email draft
   ↓
You approve → send → no reply: follow-ups (day 4, 9, 16) | reply: follow-ups cancelled
```

**Honesty is built in.** A "truth guard" rejects any generated text that claims a skill, number or
title that is not in your profile. Banned phrases ("I hope this email finds you well", "thrilled",
"proven track record", …) are blocked.

## Screenshots

| Jobs found today                   | One job: score, contact, tailored PDF, email   |
| ---------------------------------- | ---------------------------------------------- |
| ![Jobs](docs/screenshots/jobs.png) | ![Job detail](docs/screenshots/job-detail.png) |

| Outreach pipeline                          | Resume                                 |
| ------------------------------------------ | -------------------------------------- |
| ![Outreach](docs/screenshots/outreach.png) | ![Resume](docs/screenshots/resume.png) |

## Responsible use

This tool is for writing **a few thoughtful emails a day**, not mass mailing. Daily send limits,
per-company and per-recipient cooldowns, a suppression list (bounces and "please stop" replies) and
a send window are on by default — please keep them that way. Nothing is sent before you approve it.

## Who it's for

Out of the box it is tuned for **software engineers** (the default search, skill taxonomy and title
filters are engineering-focused, and locations open to India are preferred). Within that, you control
it through your profile: target roles, locations, skills. Any role you list in `target_roles` is
searched for — including titles the defaults would skip, such as "Frontend Engineer".

---

## Getting started

### 1. Requirements

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine + Compose v2)
- A few GB of free disk (the API image includes headless Chromium for resume PDFs)
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

The `candidate/` folder ships with **samples** for a fictional person ("Alex Morgan"). Copy them
and replace the contents with your own facts:

```bash
cp candidate/candidate-profile.example.md candidate/candidate-profile.md   # required
cp candidate/resume.example.tex candidate/resume.tex                       # optional
```

- `candidate-profile.md` — your roles, locations and skills. If you skip this, the app creates it
  from the sample on first start (and logs a warning) — replace it before sending anything.
- `resume.tex` — your resume content. Without it, the resume is built from your profile.

Both files are in `.gitignore`, so your personal details are never committed.

See [candidate/README.md](candidate/README.md) for what each field does.

### 4. Start it

```bash
docker compose up --build
```

The first build takes several minutes. When the web container is ready, open
**http://localhost:3000** and **create your account** (only the first account can register — this
is a single-user app).

The first job search starts right away. Within a couple of minutes the dashboard shows
_"We found X relevant jobs for you today."_

### 5. Daily use

Open the dashboard → pick a job → click **Prepare my application**. It checks the job, researches
the company, finds a contact, tailors your resume and drafts the email, then waits for you.
Review it and **approve** (or send the draft from Gmail directly — the app notices and starts
tracking it). Details are under [Preparing an application](#preparing-an-application).

### 6. Optional upgrades

| Want                                | Do this                                                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real emails via Gmail               | Follow [Gmail setup](#gmail) below, then `EMAIL_PROVIDER=gmail`                                                                                           |
| Free local AI                       | Install [Ollama](https://ollama.com), `ollama pull qwen2.5:7b`, then `AI_PROVIDER=ollama` and `OLLAMA_MODEL=qwen2.5:7b` (see [AI and cost](#ai-and-cost)) |
| Best analysis & writing with Claude | `AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY=...` ([get a key](https://console.anthropic.com))                                                          |
| More contacts found                 | `HUNTER_API_KEY=...` ([Hunter.io](https://hunter.io), free tier)                                                                                          |
| A4 resumes                          | `RESUME_PAGE_SIZE=A4`                                                                                                                                     |
| Different search time               | `DISCOVERY_CRON` (default `30 1 * * *` = 07:00 IST; container time is UTC)                                                                                |

After editing `.env`, restart: `docker compose up -d --force-recreate api worker`.
Check the AI connection in **Settings → Test AI connection**.

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
- **Resume step failed** — the job page shows the reason and a **Retry** button. Outside Docker,
  run `npx playwright install chromium` first.
- **`.tex` upload rejected** — the reader explains what it couldn't parse; see
  [Your resume](#your-resume) for the supported commands.
- **Gmail says "Access blocked"** — add your Gmail address under _Test users_ (step 2 of
  [Gmail](#gmail)).
- **Profile errors** — open the Profile page; it shows exactly which field is invalid.

---

## Preparing an application

Open a job: the top of the page says whether to apply (Strong match / Good match / Review manually / Not
recommended), shows salary, experience, location eligibility and company size (anything unknown says
"Unknown"), and has one main button: **Prepare my application**. Score breakdowns, contacts, the resume
and the email editor are under **More details and tools**.

_Prepare_ runs five steps in the worker (so the worker must be running) and saves progress, so a refresh
loses nothing: check the job → research the company → find a contact → tailor the resume → draft the
outreach. Each step shows _Not started / In progress / Completed / Needs your input / Failed — retry
available_; a retry redoes only what failed. At the end you get one summary and one **approve** button.

- Nothing is sent or submitted before you approve. Approving an email queues it (existing limits and
  safeguards apply); with no contact email you get an application checklist, and approving only records it.
- A posting is "listed" only when its company board confirms it; otherwise it says _could not be verified_.
- Emails are never guessed. A found-but-unverified address waits for your confirmation.
- Resume PDFs need a browser engine (`npx playwright install chromium`; included in Docker). If it is
  missing the resume step fails with that instruction; install it and retry, or **Continue without a tailored resume**.
- Lifecycle: Discovered → Shortlisted → Preparing → Ready for review → Approved → Applied → Replied →
  Interview → Offer/Rejected, plus Skipped and Archived. _Applied_ means an email was actually sent, or you
  clicked **I applied** after applying on the company's site.

## Local development (without Docker for the apps)

Node 20.12+ (22 recommended), PostgreSQL 14+, Redis 6+, and a browser for resume PDFs. Install it once:

```bash
npx playwright install chromium     # ~170 MB, stored outside the repo
```

If you skip this, the app falls back to an installed Google Chrome or Microsoft Edge, or to the binary in
`RESUME_BROWSER_PATH`. If none can be started, the resume step says so and shows this command.

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
Redis (cache, locks, rate limits, queues) → headless Chromium (resume PDFs). No microservices.

## Job discovery

Sources are seeded automatically on sign-up (Settings → _Job discovery sources_ to disable or add):

| Source                                            | How                                              | Notes                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hacker News "Who is hiring?"                      | Algolia public API                               | Startups; posters often publish their own email (stored as a verified contact)                                                                                 |
| We Work Remotely                                  | public RSS                                       | company website extracted → contact lookup                                                                                                                     |
| Remotive, Himalayas, Jobicy, Remote OK, Arbeitnow | public JSON APIs                                 | remote roles; attribution links kept                                                                                                                           |
| ~40 company boards                                | Greenhouse / Ashby / Lever public job-board APIs | verified to list India-based or globally-remote backend roles (Okta, MongoDB, Stripe, Coinbase, Databricks, GitLab, Sarvam AI, Plane, Supabase, ClickHouse, …) |

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
> sites. The app detects this and shows _"Blocked by your network …"_ on the affected sources
> instead of failing silently. On the network this was built on, a Sophos firewall intercepted
> Remotive, Himalayas, Jobicy, Remote OK, Arbeitnow and Lever; HN, We Work Remotely, Greenhouse and
> Ashby worked. Run it on a home network to use every source. Certificate checks are never disabled.

## Your resume

- `candidate/resume.tex` (next to the profile) is your resume's **content** and is picked up automatically
  the first time the resume is used. Uploading a `.tex` on the Resume page replaces it; after
  _Remove LaTeX_ the file is not re-imported.
- **The PDF is drawn from a built-in template, not by running LaTeX.** The template is one clean,
  ATS-friendly column (real selectable text; no icons, images, tables or skill bars) that mirrors the
  usual layout: centered name and contact line, Summary, Technical Skills, Experience, Production
  Challenges, Projects, Education. Letter size by default; set `RESUME_PAGE_SIZE=A4` for A4. Your own
  LaTeX _design_ (fonts, margins, packages) is not reproduced — only the content, in order.
- The `.tex` reader understands `\section`, `\subheading`/`\resumeSubheading`, `\project`,
  `\itemx`/`\resumeItem`, `\item`, `\textbf`, `\textit`/`\emph`, `\texttt`, `\href` and the usual escapes. A
  file it cannot read is rejected at upload with an explanation instead of producing a thin resume.
- **Tailoring is unchanged and factual.** It works on the `.tex` source and makes three kinds of change:
  1. re-orders bullets inside each Experience/Projects/Production Challenges list (most JD-relevant
     first),
  2. re-orders items inside comma-separated skills lines ("Languages: …"); groups in parentheses
     ("AWS (EC2, S3)") stay together,
  3. with Claude enabled (optional): rephrases _plain-text_ bullets toward the JD's wording — each rewrite
     must pass a truth guard (no new technologies, numbers, metrics or "led/owned/architected").
     Nothing is added or removed, and your master resume is never modified by tailoring.
- **Every PDF is checked before it is accepted:** it must be a real PDF with selectable text, contain your
  name, every section and every bullet (so nothing is clipped or dropped), have nothing wider than the
  page, and be at most 4 pages (it aims for 2 and tries a tighter layout once if needed). If the check
  fails, the page shows the reason and a **Retry** button; the app never substitutes a different resume.
- The job page shows the changes, a **Preview** link and a **Download PDF** button.
- Isolation: the browser renders the document with scripts and network access blocked.

Without a `.tex`, the same template is used with the structured resume built from your profile.

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
5. Settings → **Connect Gmail** → on "Google hasn't verified this app" choose _Continue_.

In testing mode Google expires the connection after 7 days (reconnect, or _Publish app_).

**Drafts.** Every prepared email (and follow-up) is mirrored into Gmail Drafts with the tailored
PDF attached and kept in sync with your edits. _Approve & send_ sends that draft (after re-checking
daily limits, cooldowns, suppression list). If you send a draft yourself from Gmail, the next sync
(every 10 min, or _Check for replies_) records it and schedules follow-ups. Cancelled follow-ups
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

**Free local AI with Ollama:** install Ollama (https://ollama.com), run `ollama pull qwen2.5:3b`, set
`AI_PROVIDER=ollama` (and optionally `OLLAMA_MODEL`, `OLLAMA_BASE_URL`) in `.env`, restart the API and worker,
then run `npm run ai:check` or click "Test AI connection" in Settings. Nothing leaves your machine. If Ollama is
off or the model is missing, the app falls back to the template writer. Pick a model that fits your RAM (3B for
8 GB, 7–8B for 16 GB+).

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
sent, and sent emails get _Simulate reply / out-of-office / bounce_ buttons.

## Database

PostgreSQL schema in `apps/api/prisma/schema.prisma`: users, profiles, resumes (incl. LaTeX source
and PDF), resume_versions (tailored .tex + PDF), companies, jobs, contacts, applications,
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
is detected". The PDF tests drive a real headless browser; on a machine without one they are skipped, and
the e2e tests instead assert the clear "install Chromium" message.

## Security

OAuth with encrypted tokens; HttpOnly SameSite session cookie; double-submit CSRF; OAuth state bound
to the user; Redis rate limiting; Zod validation; private-network URL blocking; robots.txt respected;
resume PDFs rendered with scripts and network blocked; audit log; structured JSON logs with
correlation ids (tokens, cookies, passwords and email bodies redacted).

## Project layout

```
candidate/                       Your profile + resume (git-ignored) and *.example.* samples
apps/api/src/domain/             Pure logic: scoring, extraction, filters, LaTeX parse/tailor,
                                 truth guard, guardrails, follow-up schedule, state machine
apps/api/src/providers/          Job feeds & boards, contacts, Gmail/sandbox, Claude/template AI,
                                 HTML resume template + Chromium PDF renderer, resume parser
apps/api/src/modules/            Services/controllers, discovery orchestrator, BullMQ processors
apps/api/test/                   Integration + e2e tests (mocked internet)
apps/web/                        Next.js UI
docker-compose.yml               postgres, redis, api, worker, web
```
