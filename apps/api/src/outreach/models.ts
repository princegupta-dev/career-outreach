import { listLocalModels, localModel, ollamaConfig, OutreachError } from './ollama';
import { saveSelectedModel } from './model-settings';

export interface DownloadStatus { running: boolean; model: string | null; message: string; percent: number | null; error: string | null }
export function createModelManager(fetcher: typeof fetch = fetch) {
  let state: DownloadStatus = { running: false, model: null, message: '', percent: null, error: null };
  let current: Promise<void> | null = null;
  let controller: AbortController | null = null;
  return {
    status: () => ({ ...state }),
    async list() {
      const config = ollamaConfig();
      try {
        const models = await listLocalModels(config, fetcher);
        return { selected: config.model, models: models.filter((m) => !m.remote_host && !m.remote_model && !/cloud/i.test(m.name)).map(({ name, size }) => ({ name, size: size ?? null })), download: { ...state }, error: null };
      } catch (error) { return { selected: config.model, models: [], download: { ...state }, error: (error as Error).message }; }
    },
    async select(model: string) {
      if (!/^[a-zA-Z0-9._/-]+(?::[a-zA-Z0-9._-]+)?$/.test(model) || /cloud/i.test(model)) throw new OutreachError('Choose a downloaded local model.', 400);
      await localModel({ ...ollamaConfig(), model }, fetcher);
      saveSelectedModel(model);
    },
    pull(model: string) {
      if (state.running) throw new OutreachError('A model download is already running.', 409);
      if (!/^[a-zA-Z0-9._/-]+(?::[a-zA-Z0-9._-]+)?$/.test(model) || /cloud/i.test(model)) throw new OutreachError('Enter a local model name, such as qwen3:4b.', 400);
      const config = ollamaConfig();
      controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(1800000)]);
      state = { running: true, model, message: 'Starting download…', percent: null, error: null };
      current = (async () => {
        const response = await fetcher(`${config.baseUrl}/api/pull`, { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
        if (!response.ok || !response.body) throw new Error(`Ollama download failed (HTTP ${response.status}). Start Ollama and try again.`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', success = false;
        const update = (line: string) => {
          if (!line.trim()) return;
          const event = JSON.parse(line) as { status?: string; error?: string; total?: number; completed?: number };
          if (event.error) throw new Error(event.error);
          state.message = event.status?.slice(0, 300) ?? state.message;
          state.percent = event.total && event.completed != null ? Math.min(100, Math.round(event.completed / event.total * 100)) : null;
          if (event.status === 'success') success = true;
        };
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            buffer += decoder.decode(chunk.value, { stream: true });
            const lines = buffer.split('\n'); buffer = lines.pop()!;
            for (const line of lines) update(line);
            if (buffer.length > 65536) throw new Error('Invalid download progress from Ollama.');
          }
          buffer += decoder.decode(); update(buffer);
          if (!success) throw new Error('The model download ended before Ollama confirmed success.');
          await localModel({ ...config, model }, fetcher);
          saveSelectedModel(model);
          state = { ...state, running: false, message: 'Downloaded and selected.', percent: 100 };
        } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      })().catch((error) => { state = { ...state, running: false, error: controller?.signal.aborted ? 'Download cancelled.' : (error as Error).message }; });
      return { ...state };
    },
    cancel() { controller?.abort(); },
    async settled() { await current; },
  };
}
