'use strict';

const ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE = '🔒 This challenge is active. Deactivate it first to add or change structure and media.';

const LOCKED_ACTION_CHALLENGE_PART = Object.freeze({
    questionCreate: 3, questionCreateModal: 3,
    challengeDelete: 3, challengeDeleteModal: 3,
    questionDelete: 3, questionDeleteModal: 3,
    questionEditOptions: 2, questionOptionsModal: 2,
    questionEditImageText: 2, questionImageTextModal: 2,
    questionEditAnswers: 2, questionAnswersModal: 2,
    questionEditSolutionImageLimits: 2, questionSolutionImageLimitsModal: 2,
    questionEditControlImageLimits: 2, questionControlImageLimitsModal: 2,
    questionEditDirections: 2, questionDirectionsModal: 2,
    questionEditGalleryLimits: 2, questionGalleryLimitsModal: 2,
    questionEditRotationSettings: 2, questionRotationSettingsModal: 2,
    questionClearSelector: 2, questionClearModal: 2,
    questionImagesOpen: 2, questionImagesSelect: 2,
    questionImagesClear: 2, questionImagesSave: 2,
});

function isChallengeActive(activeChallengeIds, challengeId) {
    return (activeChallengeIds ?? []).some((id) => String(id) === String(challengeId));
}

function isActiveChallengeLockedEditAction(action) {
    return Object.hasOwn(LOCKED_ACTION_CHALLENGE_PART, String(action));
}

function getActiveChallengeLockedActionChallengeId(action, parts = []) {
    return parts[LOCKED_ACTION_CHALLENGE_PART[String(action)]];
}

module.exports = {
    ACTIVE_CHALLENGE_EDIT_LOCK_MESSAGE,
    getActiveChallengeLockedActionChallengeId,
    isActiveChallengeLockedEditAction,
    isChallengeActive,
};
