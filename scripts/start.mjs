// `npm start` — starts the API (port 4000) and the dashboard (port 3000) together, opens the dashboard in your
// browser once it answers, and stops both on Ctrl+C. No extra libraries: plain Node.
import { spawn, execFile } from 'node:child_process';
import net from 'node:net';

const URL = 'http://localhost:3000';

/** Is something already listening on this port? */
const busy = (port) =>
  new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

for (const [port, what] of [[4000, 'API'], [3000, 'dashboard']]) {
  if (await busy(port)) {
    console.error(`Port ${port} (${what}) is already in use. Stop whatever runs there (or an earlier npm start), then try again.`);
    console.error(`  See what it is: lsof -iTCP:${port} -sTCP:LISTEN`);
    process.exit(1);
  }
}

/** Run an npm script with each output line prefixed, so the two logs are easy to tell apart. */
function run(name, script) {
  const child = spawn('npm', ['run', script], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter((l) => l.trim())
      .forEach((l) => console.log(`[${name}] ${l}`));
  child.stdout.on('data', prefix);
  child.stderr.on('data', prefix);
  child.on('exit', (code) => {
    if (!stopping) {
      console.log(`[${name}] stopped (exit ${code}). Stopping everything.`);
      stop(code ?? 1);
    }
  });
  return child;
}

let stopping = false;
const children = [run('api', 'dev:api'), run('web', 'dev:web')];

function stop(code = 0) {
  stopping = true;
  // Each child started its own process group (detached), so this also stops npm's children (ts-node, next).
  for (const c of children) {
    try {
      process.kill(-c.pid, 'SIGTERM');
    } catch {
      // already gone
    }
  }
  setTimeout(() => process.exit(code), 500);
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

// Open the dashboard once it answers (the first Next.js compile takes a few seconds).
for (let i = 0; i < 120 && !stopping; i++) {
  try {
    const res = await fetch(URL);
    if (res.ok) {
      console.log(`\nDashboard ready: ${URL}  (Ctrl+C stops everything)\n`);
      if (process.platform === 'darwin') execFile('open', [URL]);
      break;
    }
  } catch {
    // not up yet
  }
  await new Promise((r) => setTimeout(r, 1000));
}
