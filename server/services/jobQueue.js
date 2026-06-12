// services/jobQueue.js — Lightweight FIFO Job Queue
// Serializes async tasks (bridge generation, TTS, music refill) to prevent
// race conditions and resource contention.
//
// Design:
//   - enqueue(job) adds a job and auto-triggers drain
//   - drain() processes jobs one-at-a-time with a mutex lock
//   - dedupKey prevents duplicate jobs from being queued
//   - onComplete / onError callbacks for job lifecycle events

const logger = require('../utils/logger');

// Valid job types
const JOB_TYPES = new Set([
  'program_start',      // Full AI pipeline (context → brain → NCM → segments)
  'bridge_generation',  // Post-generation of bridge segments
  'music_refill',       // Rolling queue auto-refill
  'tts_synthesis',      // TTS audio synthesis
]);

class JobQueue {
  constructor() {
    this._queue = [];           // FIFO queue of pending jobs
    this._running = false;      // Mutex: is a job currently executing?
    this._dedupKeys = new Set(); // Active dedup keys (prevents duplicate enqueue)
    this._stats = { enqueued: 0, completed: 0, failed: 0, deduped: 0 };
  }

  /**
   * Enqueue a job for serial execution.
   * If a job with the same dedupKey already exists, it is silently dropped.
   *
   * @param {object} job
   * @param {string} job.type - Job type (must be in JOB_TYPES)
   * @param {*} job.payload - Job-specific data
   * @param {string} [job.dedupKey] - Optional dedup key; if omitted, no dedup
   * @param {Function} job.execute - Async function(payload) → result
   * @returns {{ queued: boolean, reason?: string }}
   */
  enqueue(job) {
    // Validate type
    if (!job.type || !JOB_TYPES.has(job.type)) {
      logger.warn('JOB_QUEUE', `Rejected unknown job type: ${job.type}`);
      return { queued: false, reason: 'unknown_type' };
    }

    // Validate execute function
    if (typeof job.execute !== 'function') {
      logger.warn('JOB_QUEUE', `Rejected job without execute function: ${job.type}`);
      return { queued: false, reason: 'no_execute' };
    }

    // Dedup check
    if (job.dedupKey) {
      if (this._dedupKeys.has(job.dedupKey)) {
        this._stats.deduped++;
        logger.info('JOB_QUEUE', `Deduped job: ${job.dedupKey}`);
        return { queued: false, reason: 'dedup' };
      }
      this._dedupKeys.add(job.dedupKey);
    }

    const entry = {
      id: `job:${job.type}:${Date.now()}:${this._stats.enqueued}`,
      type: job.type,
      payload: job.payload,
      dedupKey: job.dedupKey || null,
      execute: job.execute,
      status: 'pending',
      result: null,
      error: null,
      createdAt: Date.now(),
    };

    this._queue.push(entry);
    this._stats.enqueued++;
    logger.info('JOB_QUEUE', `Enqueued: ${entry.id} (queue depth: ${this._queue.length})`);

    // Fire-and-forget drain (don't block the caller)
    this.drain().catch(err =>
      logger.error('JOB_QUEUE', `Drain error: ${err.message}`)
    );

    return { queued: true, jobId: entry.id };
  }

  /**
   * Process jobs one-at-a-time until the queue is empty.
   * Uses a simple boolean mutex — only one drain() loop runs at a time.
   */
  async drain() {
    if (this._running) return; // Another drain loop is already active
    this._running = true;

    try {
      while (this._queue.length > 0) {
        const job = this._queue.shift();
        job.status = 'running';

        try {
          logger.info('JOB_QUEUE', `Running: ${job.id}`);
          const result = await job.execute(job.payload);
          job.status = 'done';
          job.result = result;
          this._stats.completed++;
          logger.info('JOB_QUEUE', `Completed: ${job.id} (${Date.now() - job.createdAt}ms)`);
        } catch (err) {
          job.status = 'failed';
          job.error = err.message;
          this._stats.failed++;
          logger.warn('JOB_QUEUE', `Failed: ${job.id} — ${err.message}`);
        } finally {
          // Release dedup key regardless of outcome
          if (job.dedupKey) {
            this._dedupKeys.delete(job.dedupKey);
          }
        }
      }
    } finally {
      this._running = false;
      // Close the race window: if a job was enqueued while we were
      // finishing up, re-trigger drain so it doesn't sit idle.
      if (this._queue.length > 0) {
        this.drain().catch(err =>
          logger.error('JOB_QUEUE', `Drain re-trigger error: ${err.message}`)
        );
      }
    }
  }

  /**
   * Get current queue statistics.
   */
  getStats() {
    return {
      pending: this._queue.length,
      running: this._running,
      ...this._stats,
    };
  }

  /**
   * Get the list of pending jobs (for debugging / inspection).
   */
  getPending() {
    return this._queue.map(j => ({
      id: j.id,
      type: j.type,
      dedupKey: j.dedupKey,
      status: j.status,
      createdAt: j.createdAt,
    }));
  }

  /**
   * Clear all pending jobs (does NOT cancel a currently running job).
   */
  clear() {
    const count = this._queue.length;
    for (const job of this._queue) {
      if (job.dedupKey) this._dedupKeys.delete(job.dedupKey);
    }
    this._queue = [];
    logger.info('JOB_QUEUE', `Cleared ${count} pending jobs`);
    return count;
  }

  /**
   * Check if a specific dedupKey is currently queued or running.
   */
  has(dedupKey) {
    return this._dedupKeys.has(dedupKey);
  }

  /**
   * Reset all statistics (useful for testing).
   */
  resetStats() {
    this._stats = { enqueued: 0, completed: 0, failed: 0, deduped: 0 };
  }
}

// Singleton
const jobQueue = new JobQueue();

module.exports = jobQueue;
module.exports.JobQueue = JobQueue; // Export class for testing
module.exports.JOB_TYPES = JOB_TYPES;
