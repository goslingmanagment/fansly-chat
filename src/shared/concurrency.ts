export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  // Iterative worker: pull the next index in a loop rather than recursing, so
  // the promise chain depth stays flat regardless of items.length / limit.
  async function worker(): Promise<void> {
    while (true) {
      const i = index++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i]!);
    }
  }

  const workerCount = items.length === 0 ? 0 : Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
