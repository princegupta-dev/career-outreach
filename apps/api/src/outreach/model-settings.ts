import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

export const modelSettingsFile = () => process.env.JOB_HUNTER_OLLAMA_SETTINGS ?? path.join(os.homedir(), '.job-hunter', 'ollama.json');
export function selectedModel(): string | null {
  try {
    const value = JSON.parse(fs.readFileSync(modelSettingsFile(), 'utf8')) as { model?: unknown };
    return typeof value.model === 'string' ? value.model : null;
  } catch { return null; }
}
export function saveSelectedModel(model: string) {
  const file = modelSettingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, JSON.stringify({ model }), { mode: 0o600 }); fs.renameSync(tmp, file); }
  finally { fs.rmSync(tmp, { force: true }); }
}
