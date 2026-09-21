/**
 * SyncQueue: Rate-limited, resilient queue for bulk Discord role and member state synchronizations.
 * Handles rate limits (HTTP 429), backoff retries, and task deduplication.
 */

class SyncQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.pendingSet = new Set(); // deduplication for pending tasks
    this.inFlightSet = new Set(); // deduplication for in-flight tasks
    this.rateLimitedUntil = 0;
    this.minDelayMs = 250; // space calls by 250ms (well under Discord 50 req/s global limit)
    this.maxRetries = 4;
  }

  /**
   * Enqueue a sync job.
   * @param {string} type - 'user' | 'guild' | 'cluster' | 'custom'
   * @param {string} id - Identifier (e.g. discordUserId, osUserId, clusterId)
   * @param {Function} taskFn - Async function to execute
   * @param {number} [attempt=1]
   */
  enqueue(type, id, taskFn, attempt = 1) {
    const key = `${type}:${id}`;
    if (this.pendingSet.has(key)) {
      return; // Already pending in queue to execute next
    }

    this.pendingSet.add(key);
    this.queue.push({ type, id, key, taskFn, attempt });

    if (!this.processing) {
      this.processQueue();
    }
  }

  /**
   * Process items in the queue sequentially.
   */
  async processQueue() {
    if (this.processing) return;
    this.processing = true;

    while (this.queue.length > 0) {
      // Respect active rate limits
      const now = Date.now();
      if (this.rateLimitedUntil > now) {
        const waitMs = this.rateLimitedUntil - now;
        await new Promise((res) => setTimeout(res, waitMs));
      }

      const item = this.queue.shift();
      this.pendingSet.delete(item.key);
      this.inFlightSet.add(item.key);

      try {
        await item.taskFn();
      } catch (err) {
        const isRateLimit =
          err.status === 429 ||
          err.code === 429 ||
          err.name === 'RateLimitError' ||
          Boolean(err.retryAfter) ||
          Boolean(err.rawError?.retry_after);

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
          console.error(`[SyncQueue] Error processing job ${item.key}:`, err.message || err);

          if (item.attempt < this.maxRetries) {
            const backoffMs = Math.pow(2, item.attempt) * 500;
            console.log(`[SyncQueue] Scheduling retry ${item.attempt + 1}/${this.maxRetries} for ${item.key} after ${backoffMs}ms`);
            setTimeout(() => {
              this.enqueue(item.type, item.id, item.taskFn, item.attempt + 1);
            }, backoffMs);
          } else {
            console.error(`[SyncQueue] Job ${item.key} exceeded max retries (${this.maxRetries}). Dropping.`);
          }
        }
      } finally {
        this.inFlightSet.delete(item.key);
      }

      // Minimum delay between Discord API calls to prevent bursts
      await new Promise((res) => setTimeout(res, this.minDelayMs));
    }

    this.processing = false;
  }

  /**
   * Get queue stats.
   */
  getStats() {
    return {
      size: this.queue.length,
      processing: this.processing,
      rateLimited: this.rateLimitedUntil > Date.now(),
      rateLimitedForMs: Math.max(0, this.rateLimitedUntil - Date.now()),
    };
  }
}

const syncQueue = new SyncQueue();
module.exports = syncQueue;
