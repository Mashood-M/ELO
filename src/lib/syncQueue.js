/**
 * SyncQueue: Rate-limited, resilient queue for bulk Discord role and member state synchronizations.
 * Handles rate limits (HTTP 429), backoff retries, and task deduplication.
 */

class SyncQueue {
  constructor() {
    this.queue = [];
    this.activeWorkers = 0;
    this.maxConcurrency = 3;
    this.processing = false;
    this.pendingSet = new Set(); // deduplication for pending tasks
    this.inFlightSet = new Set(); // deduplication for in-flight tasks
    this.rateLimitedUntil = 0;
    this.minDelayMs = 25; // fast spacing between calls (reduced from 250ms)
    this.maxRetries = 4;
  }

  /**
   * Enqueue a sync job.
   * @param {string} type - 'user' | 'guild' | 'cluster' | 'custom'
   * @param {string} id - Identifier (e.g. discordUserId, osUserId, clusterId)
   * @param {Function} taskFn - Async function to execute
   * @param {number} [attempt=1]
   * @param {Function} [resolve=null]
   * @param {Function} [reject=null]
   * @param {string} [priority='normal'] - 'high' | 'normal' | 'low'
   * @returns {Promise<any>|void}
   */
  enqueue(type, id, taskFn, attempt = 1, resolve = null, reject = null, priority = 'normal') {
    if (!resolve) {
      return new Promise((res, rej) => {
        this.enqueue(type, id, taskFn, attempt, res, rej, priority);
      });
    }

    const key = `${type}:${id}`;
    if (this.pendingSet.has(key)) {
      if (resolve) resolve(null);
      return; // Already pending in queue to execute next
    }

    this.pendingSet.add(key);
    const item = { type, id, key, taskFn, attempt, resolve, reject, priority };

    if (priority === 'high') {
      // High priority: insert ahead of normal or low priority items
      const insertIdx = this.queue.findIndex((q) => q.priority !== 'high');
      if (insertIdx === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(insertIdx, 0, item);
      }
    } else if (priority === 'low') {
      this.queue.push(item);
    } else {
      // Normal priority: insert ahead of low priority items
      const insertIdx = this.queue.findIndex((q) => q.priority === 'low');
      if (insertIdx === -1) {
        this.queue.push(item);
      } else {
        this.queue.splice(insertIdx, 0, item);
      }
    }

    this.triggerWorkers();
  }

  /**
   * Enqueues an async task and returns a Promise that resolves when the task completes.
   * Employs the queue's rate limit handling, backoff, and retry mechanisms.
   *
   * @param {string} type
   * @param {string} id
   * @param {Function} taskFn
   * @param {string} [priority='high']
   * @returns {Promise<any>}
   */
  enqueueAsync(type, id, taskFn, priority = 'high') {
    return new Promise((resolve, reject) => {
      const opKey = `${id}:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`;
      this.enqueue(type, opKey, taskFn, 1, resolve, reject, priority);
    });
  }

  /**
   * Trigger worker pool up to maxConcurrency.
   */
  triggerWorkers() {
    while (this.activeWorkers < this.maxConcurrency && this.queue.length > 0) {
      this.startWorker();
    }
    this.processing = this.activeWorkers > 0;
  }

  /**
   * Worker loop that drains the queue.
   */
  async startWorker() {
    this.activeWorkers++;
    this.processing = true;

    while (this.queue.length > 0) {
      // Respect active rate limits
      const now = Date.now();
      if (this.rateLimitedUntil > now) {
        const waitMs = this.rateLimitedUntil - now;
        await new Promise((res) => setTimeout(res, waitMs));
      }

      if (this.queue.length === 0) break;
      const item = this.queue.shift();
      if (!item) break;

      this.pendingSet.delete(item.key);
      this.inFlightSet.add(item.key);

      try {
        const result = await item.taskFn();
        if (item.resolve) item.resolve(result);
      } catch (err) {
        const isRateLimit =
          err?.status === 429 ||
          err?.code === 429 ||
          err?.name === 'RateLimitError' ||
          Boolean(err?.retryAfter) ||
          Boolean(err?.rawError?.retry_after);

        if (isRateLimit) {
          const retryAfterMs = Math.ceil(
            (err.retryAfter || (err.rawError?.retry_after ? err.rawError.retry_after * 1000 : null) || 2000)
          );
          console.warn(`[SyncQueue] Discord 429 Rate Limit encountered. Pausing queue for ${retryAfterMs + 100}ms.`);
          this.rateLimitedUntil = Date.now() + retryAfterMs + 100;

          // Re-insert at front of queue for retry
          this.pendingSet.add(item.key);
          this.queue.unshift(item);
        } else {
          console.error(`[SyncQueue] Error processing job ${item.key}:`, err?.message || err);

          if (item.attempt < this.maxRetries) {
            const backoffMs = Math.pow(2, item.attempt) * 500;
            console.log(`[SyncQueue] Scheduling retry ${item.attempt + 1}/${this.maxRetries} for ${item.key} after ${backoffMs}ms`);
            setTimeout(() => {
              this.enqueue(item.type, item.id, item.taskFn, item.attempt + 1, item.resolve, item.reject, item.priority);
            }, backoffMs);
          } else {
            console.error(`[SyncQueue] Job ${item.key} exceeded max retries (${this.maxRetries}). Dropping.`);
            if (item.reject) item.reject(err);
          }
        }
      } finally {
        this.inFlightSet.delete(item.key);
      }

      // Fast spacing between calls
      if (this.minDelayMs > 0) {
        await new Promise((res) => setTimeout(res, this.minDelayMs));
      }
    }

    this.activeWorkers--;
    this.processing = this.activeWorkers > 0;
  }

  /**
   * Process items in the queue (compatibility wrapper).
   */
  processQueue() {
    this.triggerWorkers();
  }

  /**
   * Get queue stats.
   */
  getStats() {
    return {
      size: this.queue.length,
      activeWorkers: this.activeWorkers,
      processing: this.activeWorkers > 0,
      rateLimited: this.rateLimitedUntil > Date.now(),
      rateLimitedForMs: Math.max(0, this.rateLimitedUntil - Date.now()),
    };
  }
}

const syncQueue = new SyncQueue();
module.exports = syncQueue;
