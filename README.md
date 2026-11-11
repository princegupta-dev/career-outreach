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
npm run dev:api     # http://127.0.0.1:4000
npm run dev:web     # http://localhost:3000
```

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

## Check

```bash
npm run typecheck && npm run lint && npm test
```

## Notes

- Contacts are only ones published in the posting itself. Emails are never guessed.
- Clearing browser data clears your history. Use the same browser.
