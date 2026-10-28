export type ShutdownStep = () => void | Promise<void>;

export function createIdempotentShutdown(
  steps: readonly ShutdownStep[],
): () => Promise<void> {
  let shutdownPromise: Promise<void> | undefined;

  return () => {
    shutdownPromise ??= (async () => {
      const failures: unknown[] = [];
      for (const step of steps) {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) {
        throw new AggregateError(failures, "Multiple shutdown steps failed.");
      }
    })();
    return shutdownPromise;
  };
}
