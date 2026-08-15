'use strict';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_VALIDATION_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_GUILDS = 3;
const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_SCANNED_MEMBERS = 100000;

class RoleMemberCacheError extends Error {
    constructor(message, code = 'ROLE_MEMBER_CACHE_ERROR') {
        super(message);
        this.name = 'RoleMemberCacheError';
        this.code = code;
    }
}

function asNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new RoleMemberCacheError(`${label} must be a non-empty string.`, 'INVALID_CONFIGURATION');
    }
    return value.trim();
}

function getConfiguredAllowedRoleNames({ ranksCommand, membersCommand }) {
    if (!ranksCommand || typeof ranksCommand !== 'object' || Array.isArray(ranksCommand)) {
        throw new RoleMemberCacheError('ranksCommand must be an object.', 'INVALID_CONFIGURATION');
    }
    if (!membersCommand || typeof membersCommand !== 'object' || Array.isArray(membersCommand)) {
        throw new RoleMemberCacheError('membersCommand must be an object.', 'INVALID_CONFIGURATION');
    }

    const categories = membersCommand.allowed_rank_categories;
    const explicitRanks = membersCommand.allowed_ranks;
    const disallowedRanks = membersCommand.disallowed_ranks;
    if (!Array.isArray(categories) || !Array.isArray(explicitRanks) || !Array.isArray(disallowedRanks)) {
        throw new RoleMemberCacheError(
            'membersCommand.allowed_rank_categories, membersCommand.allowed_ranks, and membersCommand.disallowed_ranks must all be arrays.',
            'INVALID_CONFIGURATION',
        );
    }

    const canonicalRoleNames = [];
    const knownRoleNames = new Set();
    for (const [category, roleNames] of Object.entries(ranksCommand)) {
        if (!Array.isArray(roleNames)) continue;
        for (const roleName of roleNames) {
            const normalizedName = asNonEmptyString(roleName, `ranksCommand.${category} role`);
            if (!knownRoleNames.has(normalizedName)) {
                knownRoleNames.add(normalizedName);
                canonicalRoleNames.push(normalizedName);
            }
        }
    }

    const selectedRoleNames = new Set();
    for (const category of categories) {
        const normalizedCategory = asNonEmptyString(category, 'membersCommand allowed rank category');
        if (!Object.prototype.hasOwnProperty.call(ranksCommand, normalizedCategory)
            || !Array.isArray(ranksCommand[normalizedCategory])) {
            throw new RoleMemberCacheError(
                `membersCommand references unknown rank category "${normalizedCategory}".`,
                'INVALID_CONFIGURATION',
            );
        }
        for (const roleName of ranksCommand[normalizedCategory]) {
            selectedRoleNames.add(asNonEmptyString(roleName, `ranksCommand.${normalizedCategory} role`));
        }
    }

    for (const roleName of explicitRanks) {
        const normalizedName = asNonEmptyString(roleName, 'membersCommand allowed rank');
        if (!knownRoleNames.has(normalizedName)) {
            throw new RoleMemberCacheError(
                `membersCommand.allowed_ranks contains "${normalizedName}", which is not defined by ranksCommand.`,
                'INVALID_CONFIGURATION',
            );
        }
        selectedRoleNames.add(normalizedName);
    }

    for (const roleName of disallowedRanks) {
        const normalizedName = asNonEmptyString(roleName, 'membersCommand disallowed rank');
        if (!knownRoleNames.has(normalizedName)) {
            throw new RoleMemberCacheError(
                `membersCommand.disallowed_ranks contains "${normalizedName}", which is not defined by ranksCommand.`,
                'INVALID_CONFIGURATION',
            );
        }
        selectedRoleNames.delete(normalizedName);
    }

    return canonicalRoleNames.filter((roleName) => selectedRoleNames.has(roleName));
}

function getAllowedGuildRoles({ roleCache, ranksCommand, membersCommand }) {
    const configuredNames = getConfiguredAllowedRoleNames({ ranksCommand, membersCommand });
    const rolesByName = new Map();
    for (const role of roleCache?.values?.() ?? []) {
        if (!role || typeof role.name !== 'string' || !role.id) continue;
        const matches = rolesByName.get(role.name) ?? [];
        matches.push(role);
        rolesByName.set(role.name, matches);
    }

    const ambiguous = [];
    const roles = [];
    for (const name of configuredNames) {
        const matches = rolesByName.get(name) ?? [];
        if (matches.length === 0) continue;
        if (matches.length > 1) {
            ambiguous.push(name);
            continue;
        }
        roles.push({ id: String(matches[0].id), name });
    }

    if (ambiguous.length) {
        throw new RoleMemberCacheError(
            `The /members role configuration cannot be resolved safely (duplicate Discord role names: ${ambiguous.join(', ')}).`,
            'UNRESOLVED_ALLOWED_ROLES',
        );
    }

    if (!roles.length) {
        throw new RoleMemberCacheError(
            'None of the configured /members ranks exist in this server.',
            'UNRESOLVED_ALLOWED_ROLES',
        );
    }

    return roles;
}

function createEmptySnapshot({ guildId, roleIds, expectedCounts, createdAt }) {
    return {
        guildId: String(guildId),
        roleSignature: roleIds.join(','),
        createdAt,
        lastCountValidationAt: createdAt,
        expectedCounts,
        membersById: new Map(),
        memberIdsByRole: new Map(roleIds.map((roleId) => [roleId, new Set()])),
    };
}

function getMemberRoleIds(member, allowedRoleIds) {
    const cachedRoleIds = member?.roles?.cache;
    const ids = [];
    for (const roleId of allowedRoleIds) {
        if (cachedRoleIds?.has?.(roleId)) ids.push(roleId);
    }
    return ids;
}

function normalizeMember(member, roleIds) {
    const id = String(member?.id ?? member?.user?.id ?? '');
    if (!id) {
        throw new RoleMemberCacheError('Guild member response contained a member without an ID.', 'INVALID_MEMBER_RESPONSE');
    }
    const username = String(member?.user?.username ?? member?.username ?? 'Unknown user');
    return {
        id,
        username,
        tag: String(member?.user?.tag ?? username),
        displayName: String(member?.displayName ?? member?.nickname ?? member?.user?.globalName ?? username),
        roleIds: new Set(roleIds),
    };
}

function getLastMemberId(members) {
    const last = members[members.length - 1];
    const id = last?.id ?? last?.user?.id;
    return id ? String(id) : null;
}

function countForRole(memberCounts, roleId) {
    const count = memberCounts?.get?.(roleId);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new RoleMemberCacheError(
            `Discord did not return an authoritative member count for role ${roleId}.`,
            'INVALID_MEMBER_COUNT_RESPONSE',
        );
    }
    return count;
}

class RoleMemberCache {
    constructor({
        ttlMs = DEFAULT_TTL_MS,
        validationIntervalMs = DEFAULT_VALIDATION_INTERVAL_MS,
        maxGuilds = DEFAULT_MAX_GUILDS,
        pageSize = DEFAULT_PAGE_SIZE,
        maxPages = DEFAULT_MAX_PAGES,
        maxScannedMembers = DEFAULT_MAX_SCANNED_MEMBERS,
        now = () => Date.now(),
    } = {}) {
        this.ttlMs = ttlMs;
        this.validationIntervalMs = validationIntervalMs;
        this.maxGuilds = maxGuilds;
        this.pageSize = pageSize;
        this.maxPages = maxPages;
        this.maxScannedMembers = maxScannedMembers;
        this.now = now;
        this.snapshots = new Map();
        this.inFlight = new Map();
    }

    async getSnapshot(guild, allowedRoles) {
        if (!guild?.id || !guild?.roles?.fetchMemberCounts || !guild?.members?.list) {
            throw new RoleMemberCacheError('Guild member and role managers are required for /members.', 'INVALID_GUILD');
        }
        const roles = Array.isArray(allowedRoles) ? allowedRoles : [];
        const roleIds = roles.map((role) => String(role.id));
        if (!roleIds.length) {
            throw new RoleMemberCacheError('No allowed /members roles are configured.', 'INVALID_CONFIGURATION');
        }
        const signature = roleIds.join(',');
        const guildId = String(guild.id);
        const now = this.now();
        const current = this.snapshots.get(guildId);
        const isCompatible = current?.roleSignature === signature;
        const isFresh = isCompatible && now - current.createdAt < this.ttlMs;
        const needsCountValidation = !isFresh
            || now - current.lastCountValidationAt >= this.validationIntervalMs;

        if (isFresh && !needsCountValidation) {
            return current;
        }

        const flightKey = guildId;
        if (this.inFlight.has(flightKey)) {
            const result = await this.inFlight.get(flightKey);
            if (result.roleSignature === signature) return result;
            return this.getSnapshot(guild, allowedRoles);
        }

        const refresh = this.validateOrRefresh(guild, roleIds, current, isFresh, now)
            .finally(() => this.inFlight.delete(flightKey));
        this.inFlight.set(flightKey, refresh);
        return refresh;
    }

    async validateOrRefresh(guild, roleIds, current, isFresh, now) {
        const memberCounts = await guild.roles.fetchMemberCounts();
        if (isFresh && this.countsMatch(current, memberCounts, roleIds)) {
            current.lastCountValidationAt = now;
            return current;
        }
        return this.refreshSnapshot(guild, roleIds, memberCounts);
    }

    countsMatch(snapshot, memberCounts, roleIds) {
        return roleIds.every((roleId) => snapshot.expectedCounts.get(roleId) === countForRole(memberCounts, roleId));
    }

    async refreshSnapshot(guild, roleIds, initialMemberCounts) {
        const expectedCounts = new Map();
        const memberCounts = initialMemberCounts ?? await guild.roles.fetchMemberCounts();
        for (const roleId of roleIds) expectedCounts.set(roleId, countForRole(memberCounts, roleId));

        const next = createEmptySnapshot({
            guildId: guild.id,
            roleIds,
            expectedCounts,
            createdAt: this.now(),
        });
        let after;
        let scanned = 0;

        for (let pageNumber = 0; pageNumber < this.maxPages; pageNumber += 1) {
            const page = await guild.members.list({
                limit: this.pageSize,
                ...(after ? { after } : {}),
                cache: false,
            });
            const members = Array.from(page?.values?.() ?? []);
            if (members.length === 0) break;

            scanned += members.length;
            if (scanned > this.maxScannedMembers) {
                throw new RoleMemberCacheError(
                    `Stopped /members refresh after ${this.maxScannedMembers} members.`,
                    'MEMBER_SCAN_LIMIT_REACHED',
                );
            }

            for (const member of members) {
                const matchingRoleIds = getMemberRoleIds(member, roleIds);
                if (!matchingRoleIds.length) continue;
                const normalized = normalizeMember(member, matchingRoleIds);
                const existing = next.membersById.get(normalized.id);
                if (existing) {
                    for (const roleId of normalized.roleIds) existing.roleIds.add(roleId);
                }
                else {
                    next.membersById.set(normalized.id, normalized);
                }
                for (const roleId of matchingRoleIds) next.memberIdsByRole.get(roleId).add(normalized.id);
            }

            if (members.length < this.pageSize) break;
            const nextAfter = getLastMemberId(members);
            if (!nextAfter || nextAfter === after) {
                throw new RoleMemberCacheError('Guild member pagination did not advance.', 'PAGINATION_DID_NOT_ADVANCE');
            }
            after = nextAfter;

            if (pageNumber === this.maxPages - 1) {
                throw new RoleMemberCacheError(
                    `Stopped /members refresh after ${this.maxPages} pages.`,
                    'MEMBER_SCAN_LIMIT_REACHED',
                );
            }
        }

        const finalMemberCounts = await guild.roles.fetchMemberCounts();
        for (const roleId of roleIds) {
            const expected = countForRole(finalMemberCounts, roleId);
            const found = next.memberIdsByRole.get(roleId).size;
            if (found !== expected) {
                throw new RoleMemberCacheError(
                    `Member refresh was incomplete for role ${roleId}: expected ${expected}, found ${found}.`,
                    'MEMBER_COUNT_MISMATCH',
                );
            }
            next.expectedCounts.set(roleId, expected);
        }
        next.lastCountValidationAt = this.now();

        this.publish(next);
        return next;
    }

    publish(snapshot) {
        const guildId = snapshot.guildId;
        this.snapshots.delete(guildId);
        this.snapshots.set(guildId, snapshot);
        while (this.snapshots.size > this.maxGuilds) {
            this.snapshots.delete(this.snapshots.keys().next().value);
        }
    }
}

module.exports = {
    RoleMemberCache,
    RoleMemberCacheError,
    getConfiguredAllowedRoleNames,
    getAllowedGuildRoles,
};
