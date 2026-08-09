'use strict';

const fs = require('node:fs');

const MIB = 1024 * 1024;
const SNAPSHOT_CACHE_MS = 250;
const CGROUP_MEMORY_FILES = Object.freeze([
    Object.freeze({
        source: 'cgroup-v2',
        usage: '/sys/fs/cgroup/memory.current',
        limit: '/sys/fs/cgroup/memory.max',
    }),
    Object.freeze({
        source: 'cgroup-v1',
        usage: '/sys/fs/cgroup/memory/memory.usage_in_bytes',
        limit: '/sys/fs/cgroup/memory/memory.limit_in_bytes',
    }),
]);
const UNLIMITED_CGROUP_LIMIT = 1n << 60n;

function parseCgroupBytes(value, { allowUnlimited = false } = {}) {
    const text = String(value ?? '').trim();
    if (!text || (allowUnlimited && text === 'max')) return undefined;
    try {
        const bytes = BigInt(text);
        if (bytes < 0n || bytes > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
        if (allowUnlimited && bytes >= UNLIMITED_CGROUP_LIMIT) return undefined;
        return Number(bytes);
    }
    catch {
        return undefined;
    }
}

function createWardenMemoryAdmission({
    readFile = (file) => fs.readFileSync(file, 'utf8'),
    memoryUsage = process.memoryUsage,
    now = Date.now,
    cacheMs = SNAPSHOT_CACHE_MS,
} = {}) {
    let cached;
    let cachedAt = -Infinity;

    function readSnapshot() {
        const currentTime = now();
        if (cached && currentTime - cachedAt < cacheMs) return cached;

        for (const candidate of CGROUP_MEMORY_FILES) {
            try {
                const usageBytes = parseCgroupBytes(readFile(candidate.usage));
                const limitBytes = parseCgroupBytes(readFile(candidate.limit), { allowUnlimited: true });
                if (!Number.isFinite(usageBytes) || !Number.isFinite(limitBytes) || limitBytes < 1) {
                    continue;
                }
                cached = Object.freeze({
                    source: candidate.source,
                    usageBytes,
                    limitBytes,
                    availableBytes: Math.max(0, limitBytes - usageBytes),
                });
                cachedAt = currentTime;
                return cached;
            }
            catch {
                // Hosts do not expose a consistent cgroup version or mount path.
            }
        }

        const usageBytes = Number(memoryUsage().rss ?? 0);
        cached = Object.freeze({
            source: 'process-rss',
            usageBytes,
            limitBytes: undefined,
            availableBytes: undefined,
        });
        cachedAt = currentTime;
        return cached;
    }

    function hasHeadroom(requiredBytes, { fallbackMaxRssBytes } = {}) {
        if (!Number.isFinite(requiredBytes) || requiredBytes < 0) {
            throw new RangeError('Warden memory headroom must be a non-negative number.');
        }
        const snapshot = readSnapshot();
        if (Number.isFinite(snapshot.availableBytes)) {
            return snapshot.availableBytes >= requiredBytes;
        }
        if (Number.isFinite(fallbackMaxRssBytes)) {
            return snapshot.usageBytes < fallbackMaxRssBytes;
        }
        return true;
    }

    return Object.freeze({ hasHeadroom, readSnapshot });
}

const wardenMemoryAdmission = createWardenMemoryAdmission();

module.exports = {
    MIB,
    createWardenMemoryAdmission,
    getWardenMemorySnapshot: wardenMemoryAdmission.readSnapshot,
    hasWardenMemoryHeadroom: wardenMemoryAdmission.hasHeadroom,
};
