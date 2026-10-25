# Your candidate files

This folder is the **only place the app learns facts about you**. The files here right now belong to
the author (Prince Gupta) and work as a complete example. **Replace both with your own before you
connect Gmail** — otherwise the app will score jobs and write emails as someone else.

| File | What it is | Required? |
| --- | --- | --- |
| `candidate-profile.md` | Your profile: target roles, locations, skills, domains, projects | Yes |
| `resume.tex` | Your LaTeX resume, used as the design template for every tailored PDF | No — without it the app builds a clean PDF from the profile |

Both are mounted into Docker (`./candidate:/app/candidate`), so edits apply without a rebuild. You can
also edit the profile in the app (**Profile** page) and upload a `.tex` on the **Resume** page.

## Editing `candidate-profile.md`

The file is YAML between the two `---` lines, followed by free-form Markdown notes.

- **`name`** — used in the email sign-off and the PDF file name.
- **`target_roles`** — job titles you want. They drive discovery: a posting's title must match one of
  them (or a general engineering keyword). Words in your roles also switch off the default title
  exclusions, so `Frontend Engineer` or `Staff Engineer` will be searched even though "frontend" and
  "staff" are excluded by default.
- **`target_locations`** — include `Remote` to get remote jobs; add cities/countries for on-site ones.
- **`skills.strong`** — skills you have **used professionally**. This is the truth boundary: emails and
  resume rewrites can never claim a skill that is not here. Use common names (`Node.js`, `PostgreSQL`,
  `AWS`); they are matched against the taxonomy in `apps/api/src/domain/skills/taxonomy.ts`.
- **`skills.partial` / `skills.learning`** — shown honestly, never claimed as experience.
- **`career_start_year`** — used to compute years of experience (defaults to graduation year).
- Anything you leave blank is treated as unknown and is **never invented**.

## Using your own `resume.tex`

- It must compile on its own (pdfLaTeX, or XeLaTeX if it uses `fontspec` / `% !TEX program = xelatex`).
- Bullets in `\item` lists (or custom macros like `\resumeItem{…}`) get re-ordered per job; comma
  lists like `Languages: …` get re-ordered too. The layout, preamble and length never change.
- Extra files (`.cls`, `.sty`, fonts, images) can be uploaded together on the **Resume** page.

After changing either file, open **Profile** in the app to confirm it parsed, then click
**Find jobs now** on the dashboard.

> **Privacy tip:** if you fork this repo publicly, don't commit your phone number or personal email.
> Keep your real files local (for example with `git update-index --skip-worktree candidate/*`).
