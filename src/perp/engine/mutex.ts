// src/perp/engine/mutex.ts
/** Strictly serial async executor: tasks run one at a time in call order; a rejected task never blocks the next. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
