# Job Hunter

A personal tool that finds the latest jobs that fit your profile, with optional local Ollama assistance for outreach. No database, queue, or app login.

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

Auto-apply is switched per site in `~/.job-hunter/settings.json`: `"off"`, `"dry-run"` (checks the Apply control without
clicking it) or `"on"`. Every site starts in `"dry-run"`; switching one to `"on"` is your approval. Limits in code: 30
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

## Prepare outreach with Ollama

1. Install and open [Ollama](https://ollama.com/download) once, then start Job Hunter with `npm start`.
2. Open **Setup** in the dashboard. Download a local model (default `qwen3:4b`), watch its progress, or select an installed model. No terminal commands are needed for model management. A successful download also selects the model.
3. In **Jobs**, click **Prepare outreach** on a saved job.
4. Review the assessment, quoted job requirements, supporting experience, gaps, and questions. Edit and copy the email or LinkedIn message yourself. Draft edits survive switching workspace tabs; copy them before reloading the page.

Ollama selects relevant facts from professional skills in `candidate/candidate-profile.md` and bullets in `candidate/resume.txt`. Resume bullets mentioning skills outside your strong list are excluded from draft evidence. If the plain-text resume is missing, professional skill facts still work. Your candidate files are never edited. The model's explanations are advisory; requirement quotations and evidence IDs are checked against the saved sources. Draft claims are assembled from those verified facts, rather than free-form model claims. No supporting evidence means no draft.

This feature never sends email, creates Gmail drafts, applies, or looks up contacts. It does not change job scoring or discovery. Only the local model receives the selected skills, evidence, and job description; contact headers, compensation preferences, and the full profile are not included in the prompt. The first analysis may take a couple of minutes. Discovery continues to work if Ollama is unavailable.

The selected model is saved in `~/.job-hunter/ollama.json`. The UI selection takes precedence over `OLLAMA_MODEL`. Optional advanced settings are shell environment variables (the API does **not** automatically load `.env`):

```bash
OLLAMA_MODEL=qwen3:8b OLLAMA_TIMEOUT_MS=180000 npm start
```

Pull a different model before selecting it. Choose the model size to fit your machine's available memory. `OLLAMA_BASE_URL` defaults to `http://127.0.0.1:11434` and accepts only local HTTP addresses. Cloud model names and installed models marked as remote are rejected. To disable Ollama's own cloud features as well, see [Ollama's local-only configuration](https://docs.ollama.com/faq#how-do-i-disable-ollamas-cloud-features).

Analyses are cached privately in `apps/api/.cache/outreach/` (override with `JOB_HUNTER_OUTREACH_DIR`). The cache key includes the job, profile, resume, configured model, and prompt/schema version. Unchanged requests reuse validated results even if Ollama is stopped. If you replace a model under the same name, remove its cached analyses to force a new run. Delete this directory to clear analyses; your edits in the text boxes are temporary and should be copied before leaving the page.

API: `GET /api/ollama` reports model availability; `POST /api/outreach?jobId=...` prepares a job already in the shared saved results. Concurrent requests for the same job share one generation; a different job receives a busy message until that generation finishes.

## Naukri automatic applications

Open **Naukri auto-apply** in the dashboard. This workflow uses Naukri only and keeps your current candidate profile and preferences as its job filter.

1. Use **Setup** to log in to Naukri in your own Chrome. Select your existing local Qwen model there if you want Ollama assistance.
2. Confirm your application facts under **Saved answers**. Salary, notice period, work authorization, employer-history answers and exact experience figures are not guessed. An explicitly saved **No** can answer a skill screening question without claiming experience you do not have.
3. In **Naukri auto-apply**, set the posting window, minimum score and jobs per run. **Find fresh Naukri jobs** searches only Naukri; it never applies. Missing descriptions and old job links are excluded or checked again before Apply.
4. Review the matching-job preview. Jobs are re-scored against the current profile. Primary stacks outside your professional strengths, lower-fit roles, already-applied jobs, duplicates and employer-site applications are excluded.
5. **Check jobs without applying** verifies the job links and Apply controls. It does not click Apply or open screening questions, because Naukri may submit immediately on the first click.
6. Set **Naukri mode → Automatic submissions**, save the rules, and click **Auto-apply to … matching jobs**. The preview must still match the current jobs, profile, answers and history. Chrome stays visible; progress and results appear in the panel.

The Naukri engine supports quick apply, its chatbot text/number questions and non-button Save controls, single/multiple choices, native multi-field forms, dropdowns, accessible autocomplete, and explicitly requested resume uploads. Add an application PDF in the panel for upload questions; the original candidate files are preserved. Professional-skill yes/no answers can use the strong-skill list, while exact years require your confirmed values. Ollama selects verified resume evidence for narrative answers and never writes browser code or invents facts.

A blocked question appears in **Saved answers**. Dashboard runs pause with Chrome open. Save the missing fact or complete the visible field manually, return to the application panel, and choose **I completed the step — continue**. The same job is rechecked before work resumes. CLI runs without the dashboard handoff still record **Needs answers** and can retry when confirmed answers change. Existing entries in a form are preserved. Sensitive questions, unchecked consent/declarations, unsupported controls, CAPTCHA and login checks use the manual Chrome handoff in dashboard runs.

The hard ceiling is **30 applications per day across all sites**, with 20–40 seconds between jobs. **Stop run** stops further work and closes the application browser. If Apply might have reached Naukri but no completion can be verified, the job is marked **Verify on website**, reserves a daily slot and is not retried automatically. Open the job and check its status; only if you confirm it was not applied can you use **I checked Naukri: not applied — allow retry**. Confirmed applications cannot be reset through that action.

Naukri's **Apply Confirmation → Applied to "job title"** page is checked against the exact intended title. **Verify saved confirmations** repairs historical failed records only when their own saved page proves that job was applied to, preserving the recorded application date. Application records are written before clicking Apply so a crash cannot silently make the same job eligible again. Confirmed results sync to the Jobs page's Applied marks.

API: `GET /api/naukri/preview`, `GET /api/naukri/status`, `POST /api/naukri/settings`, `/find`, `/start`, `/stop`, `/retry`, `/resume`, `/reconcile`. PDFs and historical repair backups live in the git-ignored `apps/api/.cache/naukri/`. `JOB_HUNTER_NAUKRI_RESUME` can override the PDF path. The CLI uses the same verified engines for Naukri, Hirist and Instahyre.

## Hirist, Instahyre and company applications

Use the dedicated **Hirist auto-apply**, **Instahyre auto-apply**, **LinkedIn Easy Apply**, **Wellfound auto-apply**, or **Company websites** panel. Each panel has its own Off / Check jobs only / Automatic submissions switch. Score, posting window and run size use the shared settings; all panels share the 30/day ceiling, confirmed answers, private application PDF, durable application log and duplicate protection. Only one discovery, application or login browser can run at a time. Naukri remains a separate workflow.

1. Log in to Hirist and Instahyre through **Setup**. Use **Find fresh … jobs** in the chosen panel. Board discovery reads at most 15 full job pages in addition to listing pages; card-only results are excluded from automatic applications until their full descriptions are available.
2. Review the matching jobs and use **Check jobs without applying** first. Hirist checks its current-posting Apply controls. Instahyre can search the candidate Opportunities workspace, verify the exact job ID plus company/title, and open **View job** without clicking Apply.
3. Confirm missing facts in **Saved answers**, upload a PDF if a form needs it, enable Automatic submissions, save the rules and start the previewed batch. Supported screening fields reuse the same confirmed-answer engine as Naukri.
4. Inspect outcomes in the panel. Unknown required answers and required consent pause for manual input in Chrome. Unverified submissions reserve quota and require an explicit website check before retry. Instahyre's offers to apply to additional jobs are never accepted automatically.

**Company websites** supports **Greenhouse, Lever, Ashby, Workday and supported native custom career forms**. Direct ATS postings and unique published Apply links or embedded ATS forms on company pages can be followed. LinkedIn postings can enter this queue for employer-site applications; resolution follows a published external application link only. LinkedIn Easy Apply and Wellfound have their own dedicated panels. Account flows, ambiguous redirects, CAPTCHA and unsupported custom controls pause with Chrome open; complete the requested step yourself and continue from the dashboard. There is no universal adapter for every company website.

External destinations are verified against the saved title and supported ATS posting ID. The final destination is saved in application history, so the same job reached through another board or tracking URL is not submitted twice. Standard text, number, dropdown, radio/checkbox-group, accessible autocomplete and PDF resume controls are supported. Optional unknown or sensitive fields stay blank; required unanswered fields stop submission. Tests use intercepted pages and temporary data; a dry check never clicks a board Apply button.

The application PDF uploaded in any panel is shared across platforms. `JOB_HUNTER_APPLICATION_RESUME` overrides its path, with `JOB_HUNTER_NAUKRI_RESUME` retained as a fallback. The default remains `apps/api/.cache/naukri/resume.pdf` with private file permissions.

API: `/api/hirist`, `/api/instahyre`, `/api/linkedin`, `/api/wellfound`, and `/api/external` provide `GET /preview`, `GET /status`, `POST /settings`, `/find`, `/start`, `/stop`, `/continue`, `/retry`, and `/resume`, with the same preview-token and confirmed-retry requirements as Naukri. Historical snapshot reconciliation is Naukri-specific.

## LinkedIn, Wellfound and resumable Chrome handoffs

**LinkedIn Easy Apply** uses the signed-in Chrome job page, contact/screening steps, review and final Submit application. Use **Setup → LinkedIn → Open login in Chrome** once. Fresh LinkedIn discovery uses the existing public LinkedIn job provider. Employer-site jobs remain in **Company websites**. LinkedIn's own application/speed limits stop the batch, in addition to the shared 30/day cap. The optional follow-company checkbox is cleared before submission; application automation does not follow companies or send separate messages.

**Wellfound auto-apply** uses the job's Apply dialog and Send Application control. A required note must have confirmed wording or verified resume evidence; unsupported motivation questions pause for your input. Your Wellfound profile and resume remain the board's source of application information. Expired jobs and changed titles are rejected.

**Workday** supports recognized `myworkdayjobs.com` and `myworkdaysite.com` job identities, Apply Manually, supported information fields, Save and Continue, and review/submit steps. Account creation, passwords, email verification, dates, complex experience repeaters, declarations and unsupported widgets are completed by you in Chrome. The tool resumes on supported steps after your input. Custom native company forms use the same confirmed facts and PDF upload. A new custom destination can require your review; changing a known ATS posting ID never silently selects another job.

When a dashboard application needs login, CAPTCHA, an unknown answer or a custom control, the run shows **Continue in Chrome** and retains the same browser. Complete the requested step yourself, then press **I completed the step — continue**. You can also save an answer under **Saved answers** and return to resume. Passwords are never read, stored or filled, and CAPTCHA is never solved or bypassed by the tool. Query-string tokens are omitted from handoff status URLs.

A durable verification record is saved before giving manual control, because you may submit the form yourself. **Skip this job**, **Stop run**, closing Chrome, a restart, or an unverified completion leaves that record protected against automatic retry. Each handoff has a one-use token; old Continue requests are rejected. Competing discovery/application/login sessions remain blocked while waiting. A profile edit requires stopping and refreshing the preview before further automatic work. A paused handoff has no automatic resume timeout.

Live checks only read job pages or verify controls. Submission tests use isolated Chrome profiles with intercepted/local fixtures. Full live submission remains dependent on the employer's current forms, your login and confirmed data; unsupported steps use the handoff rather than guessed answers.

## Fill and review applications from the dashboard

The workspace has **Jobs**, dedicated **Naukri**, **Hirist**, **Instahyre**, **LinkedIn Easy Apply** and **Wellfound** panels, **Company websites**, **Apply & review**, **Saved answers**, and **Setup**. General discovery, source filters, job tracking and skill gaps stay in Jobs. Model downloads, model selection, and board login windows are in Setup.

1. In **Setup**, open a job board login in Chrome. Log in directly on the site, then close the session from the dashboard. Supported review boards: Naukri, Hirist and Instahyre; Wellfound login is also available for discovery.
2. In **Saved answers**, add, edit, confirm, or remove your reusable application facts. Salary, notice period, work authorization and exact experience figures must be explicitly confirmed. Existing entries marked `facts` are shown as needing confirmation and are not used by this review mode until you confirm them. Profile-based total years are not substituted for exact years per skill. Conflicting answers stay manual.
3. In Jobs, click **Fill and review application**, or choose a saved job in **Apply & review**. Your logged-in Chrome opens the job. The tool does not click Apply: some boards submit immediately when that button is clicked.
4. Open the application form yourself, then click **Fill visible form** in the dashboard. The current step is filled in the background; progress and the field-by-field results appear in the UI. Name, contact details and education come from the profile or your overrides. Ollama can match different wording to known facts and select exact resume evidence for narrative questions. No model-generated browser code or unsupported experience claims are used.
5. Review the filled fields in Chrome. During filling and review, page requests and submit controls are paused. Click **Enable page controls** when ready to use Next yourself. Repeat **Fill visible form** for another step, or submit manually after reviewing the whole application.
6. Close the Chrome session from the dashboard when finished. Mark the job Applied in Jobs yourself after confirming submission on the site.

The tool fills supported native text inputs, textareas, dropdowns and radio groups, preserving existing entries. Uploads, consent checkboxes, sensitive information, ambiguous numeric units, unlabeled/custom controls, login and CAPTCHA checks stay manual. It never clicks Next, Apply or Submit in this mode. Company-site redirects and unsupported hosts are left for manual completion. Job discovery and application/login sessions share one Chrome profile, so the dashboard prevents them from opening competing sessions.

Saved answers remain in `~/.job-hunter/answers.json`; unknown questions appear in the UI and in `unanswered-questions.json`. Review does not change the existing per-site auto-apply switches. Automatic submission runs share confirmed facts and local Ollama evidence selection. The application browser stays open until you close it, and review does not mark a job as submitted.

API: `GET /api/application` reports the session; `POST /api/application/open?jobId=...` opens it; `POST /api/application/fill` starts filling; `/resume` returns manual control; `/close` closes the browser; `/login?site=...` opens login. `GET|POST|DELETE /api/application/answers` manages saved answers. `GET|POST /api/ollama/models` lists/selects models, and `POST|GET /api/ollama/pull` starts/reports downloads (`POST /api/ollama/pull/cancel` cancels).

## Notes

- Contacts are only ones published in the posting itself. Emails are never guessed.
- Clearing browser data clears your history. Use the same browser.
