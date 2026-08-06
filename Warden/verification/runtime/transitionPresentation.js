'use strict';

const { buildVerificationStateOptions } = require('../presentation/documents/notices');
const {
    editStoredVerificationMessage,
    getQuestionMessageHandle,
} = require('./liveMessageRenderer');

async function showScreenTransitionProcessing(interaction, session, transitionContext = {}) {
    const questionHandle = getQuestionMessageHandle(session);
    if (!questionHandle) {
        throw new Error('The active verification screen has no editable message.');
    }

    const message = await editStoredVerificationMessage(
        interaction,
        questionHandle,
        buildVerificationStateOptions(undefined, {
            renderer: questionHandle.renderer,
            templateKey: 'nextScreenProcessingEmbed',
        }),
    );
    if (!message?.id) {
        throw new Error('Discord did not confirm the verification processing state.');
    }
    Object.assign(transitionContext, {
        questionHandle,
        transitionProcessingPresented: true,
    });

    return transitionContext;
}

module.exports = { showScreenTransitionProcessing };
