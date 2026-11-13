# Job Hunter

A personal tool that finds the latest jobs that fit your profile. No database, no queue, no AI, no login.

- **API** (`apps/api`): `GET /api/jobs/search?days=7`. It fetches company career sites (Greenhouse, Lever,
  Ashby, Workday), startups with 50–100 people, Indian product companies, and (optionally) Wellfound, Hirist,
  Instahyre, Naukri, LinkedIn and Indeed through your logged-in Chrome; filters them, scores them against
  `candidate/candidate-profile.md`, and returns JSON. It stores nothing.
- **Web** (`apps/web`): one page. Press "Find jobs". Jobs, what you have already seen, and
  applied/skipped marks are kept in your browser's localStorage, so a job is never shown as new twice.

## Run

```bash
npm install
npm start           # API + dashboard together; opens http://localhost:3000. Ctrl+C stops both.
```

On the dashboard, **Discover today's jobs** runs the same workflow as `npm run discover` in the background
(Chrome windows open and close by themselves; do not close them) and shows its progress; when it finishes, the list
switches to today's picks. Tick **email** to also email the Excel. (Separately: `npm run dev:api` / `npm run dev:web`.)

Or straight from the terminal (writes `apps/api/jobs.json`):

```bash
npm run fetch -- 7  # jobs posted in the last 7 days
```

## Job boards (Wellfound, Hirist, Instahyre, Naukri, LinkedIn)

These need you to be logged in. They are read through your own Google Chrome with a separate profile
(`~/.job-hunter/chrome-profile`), slowly (3–7 s between pages, max 15 job pages per site), read-only:
it never clicks Apply, never messages anyone. Your password is never stored by this tool.

```bash
npm run login -- wellfound hirist instahyre   # log in yourself in the window, then press Enter in the terminal
npm run fetch -- 7 --sites=default            # Wellfound + Hirist + Instahyre
npm run fetch -- 7 --sites=naukri,linkedin    # only if you accept the risk (against their terms)
npm run fetch -- 7 --sites=hirist --snapshot  # also saves pages to apps/api/.cache/snapshots
```

Jobs are read from the schema.org `JobPosting` data these sites publish for Google.

## Discover: up to 50 new jobs a day, you apply yourself

```bash
npm run discover                 # LinkedIn, Naukri, Instahyre, Wellfound, Hirist → quality gate → dashboard
npm run discover -- --email      # also email the Excel (Today's jobs, Skill gaps, Experience)
npm run discover -- --snapshot   # also save pages, when a site needs fixing
```

- Never applies. Only the five sources above (no company boards, no startup lists).
- Quality gate: score ≥ `minScore` (settings), a priority role (backend / Node.js / TypeScript / platform / AI backend
  first, then software/SDE, then full-stack), open to India, not staff/principal/manager/junior, not asking for much
  more experience than you have. Fewer than 50 when fewer qualify; quality is never lowered.
- Never the same job twice: permanent history in `apps/api/.cache/history.json` (by id and by company + title,
  so the same job on two sites counts once).
- Skill gaps over every qualified job: demand count and %, what you have, what your resume does not show, what is
  missing, and how often jobs ask for more years than you have. On the dashboard ("Skill gaps") and in the Excel.
- Dashboard: "Daily picks" filter, minimum score, posting date, missing skills on every job, description under
  "Details", and "Daily stats" per source.

## Daily: one command

```bash
npm run daily      # find jobs (company sites + Naukri, Hirist, Instahyre, Wellfound) → dashboard → auto-apply
npm run answers    # answer, once, any application question the tool met and could not answer
```

Auto-apply is switched per site in `~/.job-hunter/settings.json`: `"off"`, `"dry-run"` (everything but the final
click) or `"on"`. Every site starts in `"dry-run"`; switching one to `"on"` is your approval. Limits in code: 30
applications a day, never the same job twice, 20–40 s between applications, company-site jobs skipped.

Questions are answered from `~/.job-hunter/answers.json`: a bank built from your profile and facts, plus your own
entries (yours always win). It never answers gender, date of birth or disability, and never claims years in a skill
that is not one of your strong skills. Anything it cannot answer is saved and asked by `npm run answers`.

One-time: `npm run login -- naukri hirist instahyre wellfound` (log in, then press Enter).

### Excel report + email

Every `npm run daily` writes `~/.job-hunter/reports/jobs-YYYY-MM-DD.xlsx` (sheets: *Apply manually* with the reason
each job was not auto-applied, *Applied*, *All jobs*; with links, emails published in the posting, the LinkedIn
poster when shown, and the job description) and emails it to you. `npm run report` rebuilds and emails it only.

To enable the email, once:
1. Turn on 2-Step Verification for your Google account (required for App Passwords).
2. Open https://myaccount.google.com/apppasswords, create one named "Job Hunter", copy the 16 characters.
3. Put it in `~/.job-hunter/mail.json` as `"appPassword"`. Revoke it there any time.

## Check

```bash
npm run typecheck && npm run lint && npm test
```

## Notes

- Contacts are only ones published in the posting itself. Emails are never guessed.
- Clearing browser data clears your history. Use the same browser.
