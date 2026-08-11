'use strict';

const tails = new Map();

async function runWithLeaderboardWriteLock(guildId, operation) {
    if (typeof operation !== 'function') throw new TypeError('A Leaderboard write callback is required.');
    const key = String(guildId ?? '').trim();
    if (!key) throw new TypeError('A guild ID is required for a Leaderboard write.');

    const previous = tails.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    tails.set(key, current);

    await previous;
    try {
        return await operation();
    }
    finally {
        release();
        if (tails.get(key) === current) tails.delete(key);
    }
}

module.exports = { runWithLeaderboardWriteLock };
