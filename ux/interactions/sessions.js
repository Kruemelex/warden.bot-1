'use strict';

const { randomBytes } = require('node:crypto');
const { DISCORD_MESSAGE_LIMITS } = require('../components/budget');

const DEFAULT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const DEFAULT_SESSION_MAX_ENTRIES = 250;
const DEFAULT_SESSION_MAX_ROUTES = 2000;

function createPanelSessionRegistry({
    prefix,
    label = 'Panel',
    ttlMs = DEFAULT_SESSION_TTL_MS,
    maxEntries = DEFAULT_SESSION_MAX_ENTRIES,
    maxRoutesPerSession = DEFAULT_SESSION_MAX_ROUTES,
    maxCustomIdLength = DISCORD_MESSAGE_LIMITS.customIdLength,
    now = Date.now,
    randomToken = () => randomBytes(9).toString('base64url'),
} = {}) {
    const normalizedPrefix = String(prefix ?? '').trim();
    if (!normalizedPrefix || normalizedPrefix.includes(':')) {
        throw new Error('Panel session prefixes must be non-empty and cannot contain colons.');
    }
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('Panel session TTL must be positive.');
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error('Panel session capacity must be positive.');
    if (!Number.isInteger(maxRoutesPerSession) || maxRoutesPerSession < 1) {
        throw new Error('Panel session route capacity must be positive.');
    }

    const records = new Map();

    function prune() {
        const currentTime = now();
        for (const [token, record] of records) {
            if (currentTime >= record.expiresAt) records.delete(token);
        }
        while (records.size > maxEntries) records.delete(records.keys().next().value);
    }

    function nextToken() {
        let token;
        do token = String(randomToken());
        while (!token || token.includes(':') || records.has(token));
        return token;
    }

    function create({ ownerUserId, guildId, state = {} } = {}) {
        const normalizedOwner = String(ownerUserId ?? '').trim();
        const normalizedGuild = String(guildId ?? '').trim();
        if (!normalizedOwner) throw new Error(`${label} sessions require an owner user ID.`);
        if (!normalizedGuild) throw new Error(`${label} sessions require a guild ID.`);

        prune();
        while (records.size >= maxEntries) records.delete(records.keys().next().value);

        const token = nextToken();
        const createdAt = now();
        const record = {
            createdAt,
            expiresAt: createdAt + ttlMs,
            formGeneration: 0,
            guildId: normalizedGuild,
            nextRoute: 0,
            ownerUserId: normalizedOwner,
            routes: new Map(),
            state,
            token,
        };

        function addRoute(action, parts = [], routeState = {}, kind = 'action') {
            if (!records.has(token) || now() >= record.expiresAt) {
                records.delete(token);
                throw new Error(`${label} session has expired.`);
            }
            record.nextRoute = (record.nextRoute + 1) % Number.MAX_SAFE_INTEGER;
            const routeId = record.nextRoute.toString(36);
            record.routes.set(routeId, {
                action: String(action),
                claimed: false,
                kind,
                parts: [].concat(parts).map(String),
                state: routeState ?? {},
            });
            while (record.routes.size > maxRoutesPerSession) {
                record.routes.delete(record.routes.keys().next().value);
            }

            const customId = `${normalizedPrefix}:${token}:${routeId}`;
            if (customId.length > maxCustomIdLength) {
                record.routes.delete(routeId);
                throw new Error(`${label} custom ID exceeded Discord's ${maxCustomIdLength}-character limit.`);
            }
            return customId;
        }

        const session = Object.freeze({
            build: (action, ...parts) => addRoute(action, parts),
            buildState: (action, parts, routeState = {}) => addRoute(action, parts, routeState),
            buildForm: (action, parts = [], baseline = {}, sourceCustomId) => addRoute(action, parts, {
                baseline,
                formGeneration: record.formGeneration,
                sourceCustomId: String(sourceCustomId ?? ''),
            }, 'form'),
            dispose: () => records.delete(token),
            invalidateForms: () => { record.formGeneration += 1; },
            isFormGenerationCurrent: (generation) => Number(generation) === record.formGeneration,
        });
        record.session = session;
        records.set(token, record);
        return session;
    }

    function parse(customId) {
        const [idPrefix, token, routeId, ...extra] = String(customId ?? '').split(':');
        if (idPrefix !== normalizedPrefix) return null;
        if (!token || !routeId || extra.length > 0) return { expired: true };

        prune();
        const record = records.get(token);
        const route = record?.routes.get(routeId);
        if (!record || !route) return { expired: true };
        if (route.kind === 'form' && !record.session.isFormGenerationCurrent(route.state.formGeneration)) {
            return {
                expired: true,
                stale: true,
                guildId: record.guildId,
                ownerUserId: record.ownerUserId,
            };
        }

        return {
            action: route.action,
            guildId: record.guildId,
            kind: route.kind,
            ownerUserId: record.ownerUserId,
            parts: route.parts,
            state: {
                ...record.state,
                ...route.state,
                guildId: record.guildId,
                ownerUserId: record.ownerUserId,
                panelSession: record.session,
            },
            claim: () => {
                if (route.claimed || !records.has(token) || now() >= record.expiresAt) return false;
                if (route.kind === 'form' && !record.session.isFormGenerationCurrent(route.state.formGeneration)) {
                    return false;
                }
                route.claimed = true;
                return true;
            },
        };
    }

    function dispose(session) {
        if (session?.dispose) return session.dispose();
        return records.delete(String(session ?? ''));
    }

    return Object.freeze({
        create,
        dispose,
        parse,
        prune,
        size: () => {
            prune();
            return records.size;
        },
    });
}

module.exports = {
    createPanelSessionRegistry,
};
