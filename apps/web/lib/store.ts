/**
 * Everything the app remembers lives in the browser's localStorage. No database.
 * The pure merge logic is separate from the storage calls so it can be tested.
 */
export type JobStatus = 'new' | 'applied' | 'skipped';

export interface Contact {
  name: string;
  role?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  source: string;
  confidence: string;
}

export interface Job {
  id: string;
  title: string;
  company: string;
  location: string | null;
  url: string | null;
  postedAt: string | null;
  source: string;
  salaryText: string | null;
  /** Headcount when a startup directory reports it; null for most big-company boards. */
  teamSize?: number | null;
  score: number;
  recommendation: string;
  reasons: string[];
  missingSkills: string[];
  flags: string[];
  contacts: Contact[];
  /** Set by the server's shared results file: when any run (terminal or dashboard) first found this job. */
  firstSeenAt?: string;
}

export interface StoredJob extends Job {
  status: JobStatus;
  /** When this tool first showed the job. Used for the "new since last search" badge. */
  firstSeenAt: string;
}

export interface State {
  jobs: Record<string, StoredJob>;
  lastRunAt: string | null;
}

const KEY = 'job-hunter:v1';
export const EMPTY: State = { jobs: {}, lastRunAt: null };

/**
 * Add a search result to what we already have. A job seen before keeps its status and first-seen date
 * (so "applied" or "skipped" is never undone by a new search); its details are refreshed.
 */
export function mergeResults(state: State, jobs: Job[], ranAt: string): State {
  const next: Record<string, StoredJob> = { ...state.jobs };
  for (const j of jobs) {
    const prev = next[j.id];
    next[j.id] = prev ? { ...j, status: prev.status, firstSeenAt: prev.firstSeenAt } : { ...j, status: 'new', firstSeenAt: j.firstSeenAt ?? ranAt };
  }
  return { jobs: next, lastRunAt: ranAt };
}

/** Where a job came from, in words. */
export const SOURCE_LABELS: Record<string, string> = {
  GREENHOUSE: 'Company site', LEVER: 'Company site', ASHBY: 'Company site', WORKDAY: 'Company site',
  WELLFOUND: 'Wellfound', HIRIST: 'Hirist', INSTAHYRE: 'Instahyre', NAUKRI: 'Naukri', LINKEDIN: 'LinkedIn', INDEED: 'Indeed',
};
/** Jobs from sources that were removed (old public feeds) are hidden, even if this browser still has them. */
export const isKnownSource = (source: string) => source in SOURCE_LABELS;
export const sourceLabel = (source: string) => SOURCE_LABELS[source] ?? source;

export function setStatus(state: State, id: string, status: JobStatus): State {
  const job = state.jobs[id];
  return job ? { ...state, jobs: { ...state.jobs, [id]: { ...job, status } } } : state;
}

export function load(): State {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...EMPTY, ...(JSON.parse(raw) as State) } : EMPTY;
  } catch {
    return EMPTY;
  }
}

export function save(state: State): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage full or blocked (private window): the page still works for this visit.
  }
}
