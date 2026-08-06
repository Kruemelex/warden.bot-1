const { botIdent } = require('../../functions');

const isWarden = botIdent().activeBot.botName === 'Warden';

if (!isWarden) {
    module.exports = {};
}
else {
    const { reportVerificationError } = require('../../Warden/verification/errorLogging');
    const autokick = require('../../Warden/verification/runtime/autokickEvents');
    const verificationStartup = require('../../Warden/verification/startup');

    function safelyHandle(eventName, handler) {
        return async (...args) => {
            try {
                return await handler(...args);
            }
            catch (err) {
                const member = args.at(-1);
                void reportVerificationError({
                    guild: member?.guild,
                    title: `⛔ Verification ${eventName} event failed`,
                    userId: member?.id,
                }, err);
                return undefined;
            }
        };
    }

    module.exports = {
        guildDelete: safelyHandle(
            'guildDelete',
            guild => verificationStartup.disposeWardenVerificationGuild(guild?.id),
        ),
        guildMemberAdd: safelyHandle(
            'guildMemberAdd',
            member => autokick.handleVerificationAutokickMemberAdd(member),
        ),
        guildMemberUpdate: safelyHandle(
            'guildMemberUpdate',
            (oldMember, newMember) => autokick.handleVerificationAutokickMemberUpdate(oldMember, newMember),
        ),
        guildMemberRemove: safelyHandle(
            'guildMemberRemove',
            member => autokick.handleVerificationAutokickMemberRemove(member),
        ),
    };
}
