'use strict';

function createKeyedOperationQueue({ maxPendingPerKey = 8 } = {}) {
    if (!Number.isSafeInteger(maxPendingPerKey) || maxPendingPerKey < 1) {
        throw new TypeError('maxPendingPerKey must be a positive integer.');
    }

    const entries = new Map();

    async function run(key, operation) {
        if (typeof operation !== 'function') throw new TypeError('A keyed operation callback is required.');
        const normalizedKey = String(key);
        let entry = entries.get(normalizedKey);
        if (!entry) {
            entry = { pending: 0, tail: Promise.resolve() };
            entries.set(normalizedKey, entry);
        }
        if (entry.pending >= maxPendingPerKey) {
            const error = new Error('Too many Staff actions are already queued for this submission. Please try again shortly.');
            error.code = 'LEADERBOARD_ACTION_QUEUE_FULL';
            throw error;
        }

        entry.pending += 1;
        const previous = entry.tail;
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        entry.tail = current;

        await previous;
        try {
            return await operation();
        }
        finally {
            entry.pending -= 1;
            release();
            if (entry.pending === 0 && entry.tail === current) entries.delete(normalizedKey);
        }
    }

    return Object.freeze({
        run,
        size: () => entries.size,
    });
}

module.exports = { createKeyedOperationQueue };
