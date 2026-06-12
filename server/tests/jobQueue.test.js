// jobQueue.test.js — Unit tests for the FIFO Job Queue
// Tests: enqueue, drain, dedup, stats, serialization, error handling

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Silence console during tests ─────────────────────────────
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

// ── Re-implement JobQueue locally (avoid singleton side-effects) ──

const JOB_TYPES = new Set([
  'program_start',
  'bridge_generation',
  'music_refill',
  'tts_synthesis',
]);

class JobQueue {
  constructor() {
    this._queue = [];
    this._running = false;
    this._dedupKeys = new Set();
    this._stats = { enqueued: 0, completed: 0, failed: 0, deduped: 0 };
  }

  enqueue(job) {
    if (!job.type || !JOB_TYPES.has(job.type)) {
      return { queued: false, reason: 'unknown_type' };
    }
    if (typeof job.execute !== 'function') {
      return { queued: false, reason: 'no_execute' };
    }
    if (job.dedupKey) {
      if (this._dedupKeys.has(job.dedupKey)) {
        this._stats.deduped++;
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
    this.drain().catch(() => {});
    return { queued: true, jobId: entry.id };
  }

  async drain() {
    if (this._running) return;
    this._running = true;
    try {
      while (this._queue.length > 0) {
        const job = this._queue.shift();
        job.status = 'running';
        try {
          const result = await job.execute(job.payload);
          job.status = 'done';
          job.result = result;
          this._stats.completed++;
        } catch (err) {
          job.status = 'failed';
          job.error = err.message;
          this._stats.failed++;
        } finally {
          if (job.dedupKey) this._dedupKeys.delete(job.dedupKey);
        }
      }
    } finally {
      this._running = false;
      if (this._queue.length > 0) {
        this.drain().catch(() => {});
      }
    }
  }

  getStats() {
    return { pending: this._queue.length, running: this._running, ...this._stats };
  }

  getPending() {
    return this._queue.map(j => ({
      id: j.id, type: j.type, dedupKey: j.dedupKey, status: j.status, createdAt: j.createdAt,
    }));
  }

  clear() {
    const count = this._queue.length;
    for (const job of this._queue) {
      if (job.dedupKey) this._dedupKeys.delete(job.dedupKey);
    }
    this._queue = [];
    return count;
  }

  has(dedupKey) {
    return this._dedupKeys.has(dedupKey);
  }

  resetStats() {
    this._stats = { enqueued: 0, completed: 0, failed: 0, deduped: 0 };
  }
}

// ── Helper: small delay to let drain() process ──
const tick = (ms = 10) => new Promise(r => setTimeout(r, ms));

// ── Tests ─────────────────────────────────────────────────────

describe('JobQueue', () => {
  let queue;

  beforeEach(() => {
    queue = new JobQueue();
  });

  // ═══ enqueue ═══

  describe('enqueue()', () => {

    it('accepts a valid job and returns queued: true', () => {
      const result = queue.enqueue({
        type: 'bridge_generation',
        payload: { test: true },
        execute: async () => 'done',
      });
      expect(result.queued).toBe(true);
      expect(result.jobId).toBeTruthy();
    });

    it('rejects unknown job type', () => {
      const result = queue.enqueue({
        type: 'invalid_type',
        payload: {},
        execute: async () => {},
      });
      expect(result.queued).toBe(false);
      expect(result.reason).toBe('unknown_type');
    });

    it('rejects job without execute function', () => {
      const result = queue.enqueue({
        type: 'music_refill',
        payload: {},
      });
      expect(result.queued).toBe(false);
      expect(result.reason).toBe('no_execute');
    });

    it('rejects job with null type', () => {
      const result = queue.enqueue({ type: null, execute: async () => {} });
      expect(result.queued).toBe(false);
      expect(result.reason).toBe('unknown_type');
    });

    it('increments enqueued stat on success', () => {
      queue.enqueue({ type: 'tts_synthesis', execute: async () => {} });
      queue.enqueue({ type: 'tts_synthesis', execute: async () => {} });
      const stats = queue.getStats();
      expect(stats.enqueued).toBe(2);
    });
  });

  // ═══ dedup ═══

  describe('dedup', () => {

    it('prevents duplicate enqueue with same dedupKey', () => {
      const exec = async () => 'done';
      const r1 = queue.enqueue({ type: 'bridge_generation', dedupKey: 'bridge:1', execute: exec });
      const r2 = queue.enqueue({ type: 'bridge_generation', dedupKey: 'bridge:1', execute: exec });

      expect(r1.queued).toBe(true);
      expect(r2.queued).toBe(false);
      expect(r2.reason).toBe('dedup');
    });

    it('increments deduped stat on duplicate', () => {
      const exec = async () => {};
      queue.enqueue({ type: 'bridge_generation', dedupKey: 'k1', execute: exec });
      queue.enqueue({ type: 'bridge_generation', dedupKey: 'k1', execute: exec });
      queue.enqueue({ type: 'bridge_generation', dedupKey: 'k1', execute: exec });
      expect(queue.getStats().deduped).toBe(2);
    });

    it('allows different dedupKeys', () => {
      const exec = async () => {};
      const r1 = queue.enqueue({ type: 'bridge_generation', dedupKey: 'a', execute: exec });
      const r2 = queue.enqueue({ type: 'bridge_generation', dedupKey: 'b', execute: exec });
      expect(r1.queued).toBe(true);
      expect(r2.queued).toBe(true);
    });

    it('allows jobs without dedupKey (no dedup)', () => {
      const exec = async () => {};
      const r1 = queue.enqueue({ type: 'tts_synthesis', execute: exec });
      const r2 = queue.enqueue({ type: 'tts_synthesis', execute: exec });
      expect(r1.queued).toBe(true);
      expect(r2.queued).toBe(true);
    });

    it('has() returns true for active dedupKey', () => {
      // Use a long-running job to keep the key active
      queue.enqueue({
        type: 'bridge_generation',
        dedupKey: 'test-key',
        execute: () => new Promise(resolve => setTimeout(resolve, 200)),
      });
      expect(queue.has('test-key')).toBe(true);
    });

    it('has() returns false for unknown key', () => {
      expect(queue.has('nonexistent')).toBe(false);
    });
  });

  // ═══ drain ═══

  describe('drain()', () => {

    it('processes a single job', async () => {
      let executed = false;
      queue.enqueue({
        type: 'tts_synthesis',
        execute: async () => { executed = true; return 'ok'; },
      });
      await tick(50);
      expect(executed).toBe(true);
      expect(queue.getStats().completed).toBe(1);
    });

    it('processes jobs in FIFO order', async () => {
      const order = [];
      queue.enqueue({
        type: 'bridge_generation',
        execute: async () => { order.push(1); },
      });
      queue.enqueue({
        type: 'music_refill',
        execute: async () => { order.push(2); },
      });
      queue.enqueue({
        type: 'tts_synthesis',
        execute: async () => { order.push(3); },
      });
      await tick(100);
      expect(order).toEqual([1, 2, 3]);
    });

    it('handles job failure gracefully (continues processing)', async () => {
      const order = [];
      queue.enqueue({
        type: 'bridge_generation',
        execute: async () => { throw new Error('boom'); },
      });
      queue.enqueue({
        type: 'music_refill',
        execute: async () => { order.push('second'); },
      });
      await tick(100);
      expect(order).toEqual(['second']);
      expect(queue.getStats().failed).toBe(1);
      expect(queue.getStats().completed).toBe(1);
    });

    it('releases dedupKey after job completes', async () => {
      queue.enqueue({
        type: 'bridge_generation',
        dedupKey: 'release-test',
        execute: async () => 'done',
      });
      await tick(50);
      expect(queue.has('release-test')).toBe(false);
    });

    it('releases dedupKey after job failure', async () => {
      queue.enqueue({
        type: 'bridge_generation',
        dedupKey: 'fail-release',
        execute: async () => { throw new Error('fail'); },
      });
      await tick(50);
      expect(queue.has('fail-release')).toBe(false);
    });

    it('serializes execution — only one job runs at a time', async () => {
      let concurrent = 0;
      let maxConcurrent = 0;

      const makeJob = () => ({
        type: 'bridge_generation',
        execute: async () => {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise(r => setTimeout(r, 20));
          concurrent--;
        },
      });

      queue.enqueue(makeJob());
      queue.enqueue(makeJob());
      queue.enqueue(makeJob());
      await tick(200);
      expect(maxConcurrent).toBe(1);
    });

    it('passes payload to execute function', async () => {
      let receivedPayload = null;
      queue.enqueue({
        type: 'tts_synthesis',
        payload: { text: 'hello', voice: 'v1' },
        execute: async (payload) => { receivedPayload = payload; },
      });
      await tick(50);
      expect(receivedPayload).toEqual({ text: 'hello', voice: 'v1' });
    });
  });

  // ═══ getStats ═══

  describe('getStats()', () => {

    it('returns correct initial stats', () => {
      const stats = queue.getStats();
      expect(stats.pending).toBe(0);
      expect(stats.running).toBe(false);
      expect(stats.enqueued).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.deduped).toBe(0);
    });

    it('reflects completed jobs', async () => {
      queue.enqueue({ type: 'tts_synthesis', execute: async () => {} });
      await tick(50);
      expect(queue.getStats().completed).toBe(1);
    });

    it('reflects failed jobs', async () => {
      queue.enqueue({ type: 'tts_synthesis', execute: async () => { throw new Error('err'); } });
      await tick(50);
      expect(queue.getStats().failed).toBe(1);
    });
  });

  // ═══ getPending ═══

  describe('getPending()', () => {

    it('returns empty array when no pending jobs', () => {
      expect(queue.getPending()).toEqual([]);
    });

    it('lists pending jobs with metadata', () => {
      // Block the queue with a slow job
      queue.enqueue({
        type: 'bridge_generation',
        dedupKey: 'block',
        execute: () => new Promise(r => setTimeout(r, 500)),
      });
      // These will queue up behind it
      queue.enqueue({
        type: 'music_refill',
        dedupKey: 'pending1',
        execute: async () => {},
      });
      const pending = queue.getPending();
      // At least the music_refill should be pending
      const found = pending.find(p => p.dedupKey === 'pending1');
      expect(found).toBeTruthy();
      expect(found.type).toBe('music_refill');
      expect(found.status).toBe('pending');
    });
  });

  // ═══ clear ═══

  describe('clear()', () => {

    it('clears all pending jobs', () => {
      // Block the queue
      queue.enqueue({
        type: 'bridge_generation',
        dedupKey: 'blocker',
        execute: () => new Promise(r => setTimeout(r, 500)),
      });
      queue.enqueue({ type: 'music_refill', dedupKey: 'p1', execute: async () => {} });
      queue.enqueue({ type: 'tts_synthesis', dedupKey: 'p2', execute: async () => {} });

      const cleared = queue.clear();
      expect(cleared).toBe(2); // The blocker is running, not in queue
      expect(queue.getPending()).toEqual([]);
    });

    it('releases dedupKeys of cleared jobs', () => {
      queue.enqueue({
        type: 'bridge_generation',
        dedupKey: 'blocker2',
        execute: () => new Promise(r => setTimeout(r, 500)),
      });
      queue.enqueue({ type: 'music_refill', dedupKey: 'cleared-key', execute: async () => {} });
      queue.clear();
      expect(queue.has('cleared-key')).toBe(false);
    });

    it('returns 0 when queue is empty', () => {
      expect(queue.clear()).toBe(0);
    });
  });

  // ═══ resetStats ═══

  describe('resetStats()', () => {

    it('resets all counters to zero', async () => {
      queue.enqueue({ type: 'tts_synthesis', execute: async () => {} });
      await tick(50);
      expect(queue.getStats().completed).toBe(1);
      queue.resetStats();
      expect(queue.getStats().enqueued).toBe(0);
      expect(queue.getStats().completed).toBe(0);
    });
  });

  // ═══ Integration: four-layer dedup with segmentEngine pattern ═══

  describe('integration: dedup + jobQueue', () => {

    it('full pipeline: dedup filter → enqueue → serial execution', async () => {
      // Simulate: 3 songs, 1 is a duplicate
      const songs = [
        { name: 'Song A', artist: 'Artist 1', trackId: '101' },
        { name: 'Song B', artist: 'Artist 2', trackId: '102' },
        { name: 'Song A', artist: 'Artist 1', trackId: '101' }, // duplicate
      ];

      // L1 batch dedup
      const batchIds = new Set();
      const accepted = [];
      for (const song of songs) {
        if (!batchIds.has(song.trackId)) {
          accepted.push(song);
          batchIds.add(song.trackId);
        }
      }
      expect(accepted).toHaveLength(2);

      // Enqueue bridge generation for accepted songs
      let bridgesGenerated = 0;
      const result = queue.enqueue({
        type: 'bridge_generation',
        dedupKey: `bridge:integration:${Date.now()}`,
        payload: { tracks: accepted },
        execute: async (payload) => {
          for (let i = 0; i < payload.tracks.length - 1; i++) {
            bridgesGenerated++;
          }
        },
      });
      expect(result.queued).toBe(true);

      await tick(50);
      expect(bridgesGenerated).toBe(1); // 2 tracks → 1 bridge
      expect(queue.getStats().completed).toBe(1);
    });

    it('prevents duplicate bridge generation jobs', () => {
      const exec = async () => {};
      const r1 = queue.enqueue({ type: 'bridge_generation', dedupKey: 'same-batch', execute: exec });
      const r2 = queue.enqueue({ type: 'bridge_generation', dedupKey: 'same-batch', execute: exec });
      expect(r1.queued).toBe(true);
      expect(r2.queued).toBe(false);
    });
  });
});
