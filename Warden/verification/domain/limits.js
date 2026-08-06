const { DISCORD_MESSAGE_LIMITS } = require('../../ux/components/budget');

const VERIFICATION_UI_LIMITS = Object.freeze({
    attachmentsPerMessage: DISCORD_MESSAGE_LIMITS.attachments,
    challengeIntroductionFields: 10,
    componentsPerMessage: DISCORD_MESSAGE_LIMITS.componentsV2,
    customIdLength: DISCORD_MESSAGE_LIMITS.customIdLength,
    embedCharactersPerMessage: DISCORD_MESSAGE_LIMITS.embedCharacters,
    embedsPerMessage: DISCORD_MESSAGE_LIMITS.embeds,
    modalInputs: 5,
    modalLabelLength: 45,
    selectOptions: DISCORD_MESSAGE_LIMITS.selectOptions,
    textInputPlaceholderLength: 100,
});

module.exports = {
    VERIFICATION_UI_LIMITS,
};
