'use strict';

const {
    isPlausibleJoinEvent,
    memberRolesAdded,
} = require('../domain/autokickPolicy');
const {
    bypassesVerification,
    enrollAutokickMember,
    hasCompletedOnboarding,
    processGrantedVerificationBypass,
    retireAutokickMember,
    startAutokickCountdown,
} = require('./autokickEngine');

async function handleVerificationAutokickMemberAdd(member) {
    if (!member?.guild || member.user?.bot || !isPlausibleJoinEvent(member)) return;
    await enrollAutokickMember(member);
}

async function handleVerificationAutokickMemberUpdate(oldMember, newMember) {
    if (!newMember?.guild || newMember.user?.bot) return;

    const wasBypassed = bypassesVerification(oldMember);
    const isBypassed = bypassesVerification(newMember);
    if ((!wasBypassed && isBypassed) || (isBypassed && memberRolesAdded(oldMember, newMember))) {
        await processGrantedVerificationBypass(newMember, { insertIfMissing: false });
        return;
    }
    if (isBypassed) return;
    if (wasBypassed) {
        await retireAutokickMember(
            newMember,
            'verification-bypass-removed',
            { insertIfMissing: false },
        );
        return;
    }

    if (!hasCompletedOnboarding(oldMember) && hasCompletedOnboarding(newMember)) {
        await startAutokickCountdown(newMember);
    }
}

async function handleVerificationAutokickMemberRemove(member) {
    if (!member?.guild || member.user?.bot || !Number.isFinite(member.joinedTimestamp)) return;
    await retireAutokickMember(
        member,
        'membership-ended',
        { insertIfMissing: isPlausibleJoinEvent(member) },
    );
}

module.exports = {
    handleVerificationAutokickMemberAdd,
    handleVerificationAutokickMemberRemove,
    handleVerificationAutokickMemberUpdate,
};
