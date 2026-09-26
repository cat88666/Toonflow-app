type Job<T> = {
  projectKey: string;
  signal?: AbortSignal;
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  onAbort?: () => void;
};

const workListeners = new Set<() => void>();

export function onAgentWork(listener: () => void): () => void {
  workListeners.add(listener);
  return () => workListeners.delete(listener);
}

export class AgentRunScheduler {
  private active = 0;
  private activeProjects = new Set<string>();
  private queue: Job<any>[] = [];

  constructor(
    private readonly maxActive = 2,
    private readonly maxQueued = 4,
  ) {}

  run<T>(projectKey: string, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    if (signal?.aborted) return Promise.reject(this.abortError());
    if (this.queue.length >= this.maxQueued && (this.active >= this.maxActive || this.activeProjects.has(projectKey))) {
      return Promise.reject(new Error("当前已有 6 个创作任务，排队已满，请稍后重试"));
    }
    for (const listener of workListeners) listener();
    return new Promise<T>((resolve, reject) => {
      const job: Job<T> = { projectKey, signal, run, resolve, reject };
      job.onAbort = () => {
        const index = this.queue.indexOf(job);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(this.abortError());
          this.drain();
        }
      };
      signal?.addEventListener("abort", job.onAbort, { once: true });
      this.queue.push(job);
      this.drain();
    });
  }

  hasWork(): boolean {
    return this.active > 0 || this.queue.length > 0;
  }

  private drain() {
    while (this.active < this.maxActive) {
      const index = this.queue.findIndex((job) => !this.activeProjects.has(job.projectKey));
      if (index < 0) return;
      const [job] = this.queue.splice(index, 1);
      job.signal?.removeEventListener("abort", job.onAbort!);
      if (job.signal?.aborted) {
        job.reject(this.abortError());
        continue;
      }
      this.active++;
      this.activeProjects.add(job.projectKey);
      const finish = () => {
        this.active--;
        this.activeProjects.delete(job.projectKey);
        this.drain();
      };
      void job.run().then(
        (value) => {
          finish();
          job.resolve(value);
        },
        (error) => {
          finish();
          job.reject(error);
        },
      );
    }
  }

  private abortError() {
    return new DOMException("Agent run cancelled", "AbortError");
  }
}

export const agentRunScheduler = new AgentRunScheduler();
