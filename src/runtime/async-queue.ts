interface QueueItem<T> {
  readonly value: T;
  readonly consumed?: () => void;
}

interface WaitingConsumer<T> {
  readonly resolve: (result: IteratorResult<T>) => void;
}

/**
 * A single-consumer async queue. Values already queued are drained before the
 * iterator closes. `pushAndWait` resolves one microtask after the consumer has
 * pulled the value, so a tool request becomes observable before execution.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: QueueItem<T>[] = [];
  private readonly consumers: WaitingConsumer<T>[] = [];
  private closed = false;

  public push(value: T): boolean {
    return this.enqueue({ value });
  }

  public pushAndWait(value: T): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve) => {
      if (!this.enqueue({ value, consumed: resolve })) resolve();
    });
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.values.length === 0) this.finishConsumers();
  }

  public [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => this.next() };
  }

  private enqueue(item: QueueItem<T>): boolean {
    if (this.closed) return false;
    const consumer = this.consumers.shift();
    if (consumer !== undefined) {
      consumer.resolve({ done: false, value: item.value });
      if (item.consumed !== undefined) queueMicrotask(item.consumed);
    } else {
      this.values.push(item);
    }
    return true;
  }

  private next(): Promise<IteratorResult<T>> {
    const item = this.values.shift();
    if (item !== undefined) {
      const result = Promise.resolve<IteratorResult<T>>({
        done: false,
        value: item.value,
      });
      if (item.consumed !== undefined) queueMicrotask(item.consumed);
      if (this.closed && this.values.length === 0) this.finishConsumers();
      return result;
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise<IteratorResult<T>>((resolve) => {
      this.consumers.push({ resolve });
    });
  }

  private finishConsumers(): void {
    for (const consumer of this.consumers.splice(0)) {
      consumer.resolve({ done: true, value: undefined });
    }
    for (const item of this.values.splice(0)) item.consumed?.();
  }
}
