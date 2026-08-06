const {
    getQuestionTaskModule,
    getQuestionTaskType,
    isGalleryQuestionTaskType,
} = require('./questionTasks/taskRegistry');
const { questionUsesPositionAnswer } = require('./answerTypes');
const { VERIFICATION_UI_LIMITS } = require('./limits');
const {
    MAX_SCREEN_EXPIRY_TEXT,
    resolveChallengeDescription,
    resolveChallengeTitle,
} = require('../presentation/challengeContent');

const POSITION_ANSWER_HELP_TEXT = 'Use the displayed image positions when answering gallery questions.';
const LEGACY_COMPOSITE_MEDIA_TITLE = 'Positions 1-25 in a labeled grid';
const LEGACY_GALLERY_MEDIA_TITLE = 'Verification image';
const LEGACY_EMBED_TEXT_LIMITS = Object.freeze({ description: 4096, fieldName: 256, fieldValue: 1024, title: 256 });

function normalizeText(value) { return String(value ?? '').trim(); }
function limitedTextLength(value, limit) { return Math.min(normalizeText(value).length, limit); }
function legacyDescriptionLength(...parts) {
    return limitedTextLength(parts.map(normalizeText).filter(Boolean).join('\n\n'), LEGACY_EMBED_TEXT_LIMITS.description);
}
function getChallengeIntroductionFields(challenge) {
    return (Array.isArray(challenge?.fields) ? challenge.fields : []).filter(Boolean).map((field) => ({
        name: normalizeText(field.name ?? field.title) || 'Information',
        value: normalizeText(field.value ?? field.content ?? field.description),
    })).filter((field) => field.value);
}

function getQuestionScreenProgressText(screens, screen, questionIndex) {
    if (questionIndex !== 0 || (screens?.length ?? 0) <= 1) return undefined;
    return `Screen ${screen.index + 1} of ${screens.length}`;
}

function getQuestionScreenPresentation(question) {
    const taskType = getQuestionTaskType(question);
    const taskModule = getQuestionTaskModule(question);
    const gallery = isGalleryQuestionTaskType(taskType);
    const attachmentCount = Number(taskModule?.getAttachmentCount?.(question) ?? 0);
    const normalizedAttachmentCount = Number.isInteger(attachmentCount) && attachmentCount > 0
        ? attachmentCount
        : 0;
    const compositeGallery = gallery && question?.generatedImage?.compositeImageGallery === true;
    return Object.freeze({
        attachmentCount: normalizedAttachmentCount,
        compositeGallery,
        gallery,
        legacyMediaEmbedCount: gallery ? normalizedAttachmentCount : 0,
        positionAnswer: questionUsesPositionAnswer(question),
        rendersMedia: gallery || normalizedAttachmentCount > 0,
        taskType,
    });
}

function countQuestionScreenComponents(challenge, screens, screen, { includeIntro = true } = {}) {
    // Runtime screens always include the container, expiry text, the divider
    // before the action row, the action row itself, and its primary action.
    let count = 5;
    const screenIncludesIntro = includeIntro && screen.index === 0;

    if (screenIncludesIntro) {
        count += 2; // Resolved challenge title and description always render.
        count += getChallengeIntroductionFields(challenge).length;
    }
    if (screens.length > 1) count += 1;
    if (
        screen.index > 0
        && !screens[screen.index - 1]?.answerRequired
        && !(screens[screen.index - 1]?.questions ?? []).some((question) => question.answer?.required === true)
    ) count += 1;

    for (const [questionIndex, question] of (screen.questions ?? []).entries()) {
        const presentation = getQuestionScreenPresentation(question);
        if (screenIncludesIntro || questionIndex > 0) count += 1;
        count += 1; // Normalization always supplies a question label.
        if (question.text) count += 1;
        if (presentation.rendersMedia) count += 2;
        if (presentation.gallery && presentation.positionAnswer) count += 1;
    }
    return count;
}

function countQuestionScreenAttachments(screen) {
    return (screen?.questions ?? []).reduce(
        (count, question) => count + getQuestionScreenPresentation(question).attachmentCount,
        0,
    );
}

function getQuestionScreenBudget(challenge, screens, screen, { includeIntro = true } = {}) {
    const screenIncludesIntro = includeIntro && screen.index === 0;
    const fields = screenIncludesIntro ? getChallengeIntroductionFields(challenge) : [];
    let legacyEmbedCount = screenIncludesIntro ? 1 : 0;
    let legacyCharacterCount = screenIncludesIntro
        ? limitedTextLength(resolveChallengeTitle(challenge), LEGACY_EMBED_TEXT_LIMITS.title)
            + legacyDescriptionLength(resolveChallengeDescription(challenge), MAX_SCREEN_EXPIRY_TEXT)
            + fields.reduce((count, field) => count
                + limitedTextLength(field.name, LEGACY_EMBED_TEXT_LIMITS.fieldName)
                + limitedTextLength(field.value, LEGACY_EMBED_TEXT_LIMITS.fieldValue), 0)
        : 0;
    for (const [questionIndex, question] of (screen?.questions ?? []).entries()) {
        const presentation = getQuestionScreenPresentation(question);
        const helpText = presentation.gallery && presentation.positionAnswer && presentation.attachmentCount > 0
            ? POSITION_ANSWER_HELP_TEXT
            : undefined;
        legacyEmbedCount += 1 + presentation.legacyMediaEmbedCount;
        const questionDescriptionLength = legacyDescriptionLength(
            question.text,
            helpText,
            getQuestionScreenProgressText(screens, screen, questionIndex),
            MAX_SCREEN_EXPIRY_TEXT,
        );
        legacyCharacterCount += limitedTextLength(
            normalizeText(question.label ?? question.id) || `Question ${questionIndex + 1}`,
            LEGACY_EMBED_TEXT_LIMITS.title,
        ) + Math.max(1, questionDescriptionLength);
        for (let index = 0; index < presentation.legacyMediaEmbedCount; index += 1) {
            legacyCharacterCount += limitedTextLength(
                presentation.positionAnswer
                    ? (presentation.compositeGallery
                        ? LEGACY_COMPOSITE_MEDIA_TITLE
                        : `Position ${index + 1}`)
                    : LEGACY_GALLERY_MEDIA_TITLE,
                LEGACY_EMBED_TEXT_LIMITS.title,
            );
        }
    }
    return Object.freeze({
        attachmentCount: countQuestionScreenAttachments(screen),
        componentCount: countQuestionScreenComponents(challenge, screens, screen, { includeIntro }),
        legacyCharacterCount,
        legacyEmbedCount,
    });
}

function validateQuestionScreenBudgets(challenge, screens, { includeIntro = true } = {}) {
    const issues = [];
    const introductionFieldCount = getChallengeIntroductionFields(challenge).length;
    if (includeIntro && introductionFieldCount > VERIFICATION_UI_LIMITS.challengeIntroductionFields) {
        issues.push({
            screenIndex: 0,
            code: 'challenge_introduction_field_limit',
            message: `The challenge introduction contains ${introductionFieldCount} populated fields; Warden supports at most ${VERIFICATION_UI_LIMITS.challengeIntroductionFields}. Reduce its challenge information fields.`,
        });
    }

    for (const screen of screens ?? []) {
        const budget = getQuestionScreenBudget(challenge, screens, screen, { includeIntro });
        const addIssue = (code, message) => issues.push({ screenIndex: screen.index, code, message });
        if (budget.componentCount > VERIFICATION_UI_LIMITS.componentsPerMessage) {
            addIssue('components_v2_component_limit', `Screen ${screen.index + 1} still requires up to ${budget.componentCount} Discord components after automatic question-boundary splitting; the current limit is ${VERIFICATION_UI_LIMITS.componentsPerMessage}. Reduce its challenge information or question/task components.`);
        }
        if (budget.attachmentCount > VERIFICATION_UI_LIMITS.attachmentsPerMessage) {
            addIssue('discord_attachment_limit', `Screen ${screen.index + 1} can require ${budget.attachmentCount} Discord attachments; the limit is ${VERIFICATION_UI_LIMITS.attachmentsPerMessage}. Use composite galleries or mark some questions separateStep:true.`);
        }
        if (budget.legacyEmbedCount > VERIFICATION_UI_LIMITS.embedsPerMessage) {
            addIssue('legacy_embed_limit', `Screen ${screen.index + 1} can require ${budget.legacyEmbedCount} legacy Discord embeds in one verification message; the limit is ${VERIFICATION_UI_LIMITS.embedsPerMessage}. Use composite galleries or mark some questions separateStep:true.`);
        }
        if (budget.legacyCharacterCount > VERIFICATION_UI_LIMITS.embedCharactersPerMessage) {
            addIssue('legacy_embed_character_limit', `Screen ${screen.index + 1} can require up to ${budget.legacyCharacterCount} combined legacy embed characters in one verification message; the limit is ${VERIFICATION_UI_LIMITS.embedCharactersPerMessage}. Shorten its challenge information or question text, or mark some questions separateStep:true.`);
        }
    }
    return issues;
}

module.exports = {
    POSITION_ANSWER_HELP_TEXT,
    countQuestionScreenComponents,
    getQuestionScreenBudget,
    getQuestionScreenPresentation,
    getQuestionScreenProgressText,
    validateQuestionScreenBudgets,
};
