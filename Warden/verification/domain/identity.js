'use strict';

function normalizeGuildId(guildId) {
    const normalizedGuildId = String(guildId ?? '').trim();
    if (!normalizedGuildId || normalizedGuildId.toLowerCase() === 'global') {
        const error = new Error('Verification requires a real guild ID.');
        error.code = 'VERIFICATION_GUILD_ID_REQUIRED';
        throw error;
    }
    return normalizedGuildId;
}

module.exports = { normalizeGuildId };
