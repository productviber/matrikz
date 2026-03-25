export async function runWithConcurrency<T>(
  items: T[],
  workerCount: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;

  const safeWorkers = Math.max(1, Math.min(workerCount, items.length));
  let cursor = 0;

  await Promise.all(
    Array.from({ length: safeWorkers }, async () => {
      while (true) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) return;
        await worker(items[index], index);
      }
    })
  );
}
