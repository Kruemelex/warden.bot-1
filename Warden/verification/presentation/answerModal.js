'use strict';

const Discord = require('discord.js');
const { buildModalTextLabel } = require('../../../ux/components/modalFields');
const { getScreenRequiredAnswerQuestions } = require('../domain/challenges');
const { VERIFICATION_UI_LIMITS } = require('../domain/limits');
const { getQuestionScreenPresentation } = require('../domain/screenPlan');
const { getAnswerInputPresentation } = require('../domain/answerTypes');
const {
    buildSessionComponentCustomId,
    parseSessionComponentCustomId,
    resolveVerificationControlPrefixes,
} = require('./documents/challengeScreen');

// Builds the modal used to collect answers for the current live or preview screen.
function buildAnswerInputCustomId(index) {
    return `q:${index}`;
}

function getPositionAnswerMaximum(question, session) {
    const preparedCount = session?.screenAssets?.[question.id]?.galleryState?.selectedImages?.length;
    if (Number.isInteger(preparedCount) && preparedCount > 0) return preparedCount;
    const configuredCount = Number(question.generatedImage?.gallerySize);
    return Number.isInteger(configuredCount) && configuredCount > 0 ? configuredCount : 1;
}

function buildAnswerModal(session, options = {}) {
    const screen = session?.screens?.[session.screenIndex];
    if (!screen) throw new Error('The verification session has no current answer screen.');
    const requiredAnswerQuestions = getScreenRequiredAnswerQuestions(screen);
    const controlPrefixes = resolveVerificationControlPrefixes(session, options);
    if (requiredAnswerQuestions.length > VERIFICATION_UI_LIMITS.modalInputs) {
        throw new Error(`This verification screen has more than ${VERIFICATION_UI_LIMITS.modalInputs} answer inputs. Mark some questions separateStep:true.`);
    }
    const modal = new Discord.ModalBuilder()
        .setCustomId(buildSessionComponentCustomId(controlPrefixes.submit, session.screenIndex, session.token))
        .setTitle('Verify');
    for (const [index, question] of requiredAnswerQuestions.entries()) {
        const answer = question.answer ?? {};
        const positionMaximum = getQuestionScreenPresentation(question).positionAnswer
            ? getPositionAnswerMaximum(question, session)
            : undefined;
        const input = getAnswerInputPresentation(answer, { positionMaximum });
        modal.addLabelComponents(buildModalTextLabel(buildAnswerInputCustomId(index), input.label, {
            placeholder: input.placeholder,
            style: Discord.TextInputStyle.Short,
            required: true,
        }));
    }
    return modal;
}

module.exports = {
    buildAnswerInputCustomId,
    buildAnswerModal,
    parseSessionComponentCustomId,
};
