import { AsyncLocalStorage } from 'async_hooks';
import { randomUUID } from 'crypto';

export interface RequestContext {
  correlationId: string;
  userId?: string;
  ip?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Correlation context shared by HTTP requests and BullMQ jobs. */
export const requestContext = {
  run<T>(ctx: Partial<RequestContext>, fn: () => T): T {
    return storage.run({ correlationId: ctx.correlationId ?? randomUUID(), ...ctx }, fn);
  },
  get(): RequestContext | undefined {
    return storage.getStore();
  },
  correlationId(): string | undefined {
    return storage.getStore()?.correlationId;
  },
  setUser(userId: string): void {
    const store = storage.getStore();
    if (store) store.userId = userId;
  },
};
