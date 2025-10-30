class InprocQueue {
  constructor({ concurrency = 1, onError = null } = {}) {
    this.concurrency = Math.max(1, Number(concurrency) || 1);
    this.onError = onError || ((e) => console.error("[InprocQueue]", e));
    this.q = [];
    this.running = 0;
    this.stopped = false;
  }

  enqueue(name, data, runner) {
    const jobId = `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const job = { id: jobId, name, data, runner, enqueuedAt: Date.now() };
    this.q.push(job);
    this.#kick();
    return jobId;
  }

  size() {
    return this.q.length + this.running;
  }

  stop() {
    this.stopped = true;
  }

  async #runOne(job) {
    this.running += 1;
    try {
      await job.runner(job);
    } catch (e) {
      try {
        this.onError(e, job);
      } catch (_) {}
    } finally {
      this.running -= 1;
      this.#kick();
    }
  }

  #kick() {
    if (this.stopped) return;
    while (this.running < this.concurrency && this.q.length > 0) {
      const job = this.q.shift();
      // chạy tách event-loop để tránh block handler HTTP vừa trả 202
      setImmediate(() => this.#runOne(job));
    }
  }
}

module.exports = InprocQueue;
