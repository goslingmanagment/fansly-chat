export class OperationTimeoutController<Key extends string> {
  private readonly controller = new AbortController();
  private readonly handlesByKey = new Map<Key, number>();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  arm(key: Key, ms: number): void {
    this.clear(key);
    const handle = globalThis.setTimeout(() => {
      this.handlesByKey.delete(key);
      this.controller.abort();
    }, ms) as unknown as number;
    this.handlesByKey.set(key, handle);
  }

  clear(key: Key): void {
    const handle = this.handlesByKey.get(key);
    if (handle === undefined) {
      return;
    }
    clearTimeout(handle);
    this.handlesByKey.delete(key);
  }

  clearAll(): void {
    for (const handle of this.handlesByKey.values()) {
      clearTimeout(handle);
    }
    this.handlesByKey.clear();
  }
}
