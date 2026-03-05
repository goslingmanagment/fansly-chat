export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let index = 0;

  async function next(): Promise<void> {
    const i = index++;
    if (i >= items.length) return;
    results[i] = await fn(items[i]!);
    await next();
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => next()),
  );
  return results;
}
