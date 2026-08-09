/**
 * Warden verification challenge runtime helpers.
 *
 * Static challenge definitions live in challengeTemplates.js. This file
 * owns challenge normalization, runtime screen planning,
 * and answer validation. A challenge is metadata plus ordered questions[]. Runtime
 * screens are groups of questions: separateStep:true questions become their own
 * screen, while consecutive separateStep:false questions are grouped together
 * until Discord's component limit requires another screen boundary.
 */
const {
    countQuestionScreenComponents,
    validateQuestionScreenBudgets,
} = require('./screenPlan');
const {
    isSupportedAnswerType,
    validateRequiredAnswer,
} = require('./answerTypes');
const { VERIFICATION_UI_LIMITS } = require('./limits');

const DEFAULT_GENERATED_IMAGE = Object.freeze({ enabled: false, type: 'none' });
const DEFAULT_ANSWER = Object.freeze({ required: false, type: 'none' });
function isSupportedRequiredAnswerType(answerType) {
    return answerType !== 'none' && isSupportedAnswerType(answerType);
}

function normalizeGeneratedImage(generatedImage = {}) {
    const enabled = generatedImage.enabled === true;
    return {
        ...DEFAULT_GENERATED_IMAGE,
        ...generatedImage,
        enabled,
        type: generatedImage.type ?? (enabled ? 'prompt-text' : 'none'),
    };
}

function normalizeQuestionAnswer(answer = {}) {
    const type = answer.type ?? (answer.required ? 'text' : 'none');
    return {
        ...DEFAULT_ANSWER,
        ...answer,
        // Catalog rows written before answer_required became mandatory can retain a
        // type while storing NULL for the flag. Treat that as a required answer,
        // but preserve an explicit false as the administrator's No Answer choice.
        required: answer.required === true || (answer.required == null && type !== 'none'),
        type,
        accepted: Array.isArray(answer.accepted) ? answer.accepted : [],
    };
}

function getQuestionOrder(question, fallbackIndex) {
    const order = Math.floor(Number(question.order));
    return Number.isInteger(order) && order > 0 ? order : fallbackIndex + 1;
}

function sortQuestionsByOrder(questions) {
    return questions
        .map((question, index) => ({ question, index, order: getQuestionOrder(question, index) }))
        .sort((left, right) => left.order - right.order || left.index - right.index)
        .map(({ question }) => question);
}

function normalizeVerificationChallenge(challenge) {
    if (!challenge) return challenge;

    return {
        id: challenge.id,
        title: challenge.title,
        description: challenge.description,
        color: challenge.color,
        fields: Array.isArray(challenge.fields) ? challenge.fields : [],
        questions: sortQuestionsByOrder(getChallengeQuestions(challenge).map((question, index) => ({
            ...question,
            id: question.id,
            label: question.label ?? `Question ${index + 1}`,
            separateStep: question.separateStep === true,
            generatedImage: normalizeGeneratedImage(question.generatedImage),
            answer: normalizeQuestionAnswer(question.answer),
        }))),
    };
}

function getChallengeQuestions(challenge) {
    return Array.isArray(challenge?.questions) ? challenge.questions : [];
}

function getQuestionNumber(challenge, question) {
    return getChallengeQuestions(challenge).findIndex((candidate) => candidate.id === question?.id) + 1;
}

function resolveQuestion(challenge, value) {
    const questions = getChallengeQuestions(challenge);
    const rawValue = String(value ?? '').trim();
    if (!rawValue) return undefined;
    const index = Number(rawValue);
    if (Number.isInteger(index) && index >= 1 && index <= questions.length) return questions[index - 1];
    return questions.find((question) => question.id === rawValue);
}

function createQuestionScreen(questions, separate, index) {
    return {
        id: `screen-${index}`,
        index,
        questions: [...questions],
        separate,
        answerRequired: questions.some((question) => question.answer?.required === true),
    };
}

function buildConfiguredQuestionScreenGroups(challenge) {
    const groups = [];
    let groupedQuestions = [];

    const pushGroup = (questions, separate) => {
        if (questions.length < 1) return;
        groups.push({ questions: [...questions], separate });
    };

    for (const question of getChallengeQuestions(challenge)) {
        if (question.separateStep === true) {
            pushGroup(groupedQuestions, false);
            groupedQuestions = [];
            pushGroup([question], true);
            continue;
        }
        groupedQuestions.push(question);
    }

    pushGroup(groupedQuestions, false);
    return groups;
}

function splitQuestionScreenGroups(challenge, groups, assumeMultipleScreens, includeIntro) {
    const screens = [];
    const pushScreen = (questions, separate) => {
        if (questions.length < 1) return;
        screens.push(createQuestionScreen(questions, separate, screens.length));
    };
    const countCandidateComponents = (questions) => {
        const candidate = createQuestionScreen(questions, false, screens.length);
        const plannedScreens = [...screens, candidate];
        if (assumeMultipleScreens && plannedScreens.length < 2) {
            plannedScreens.push(createQuestionScreen([], false, plannedScreens.length));
        }
        return countQuestionScreenComponents(challenge, plannedScreens, candidate, { includeIntro });
    };

    for (const group of groups) {
        if (group.separate) {
            pushScreen(group.questions, true);
            continue;
        }

        let screenQuestions = [];
        for (const question of group.questions) {
            const candidateQuestions = [...screenQuestions, question];
            if (
                screenQuestions.length > 0
                && countCandidateComponents(candidateQuestions) > VERIFICATION_UI_LIMITS.componentsPerMessage
            ) {
                pushScreen(screenQuestions, false);
                screenQuestions = [question];
            }
            else {
                screenQuestions = candidateQuestions;
            }
        }
        pushScreen(screenQuestions, false);
    }

    return screens;
}

function buildQuestionScreens(challenge, { includeIntro = true } = {}) {
    const groups = buildConfiguredQuestionScreenGroups(challenge);
    const assumeMultipleScreens = groups.length > 1;
    const screens = splitQuestionScreenGroups(challenge, groups, assumeMultipleScreens, includeIntro);
    return !assumeMultipleScreens && screens.length > 1
        ? splitQuestionScreenGroups(challenge, groups, true, includeIntro)
        : screens;
}

function getScreenAnswerSpec(screen) {
    return (screen?.questions ?? [])
        .filter((question) => question.answer?.required === true)
        .map((question) => ({ questionId: question.id, ...question.answer }));
}

function screenRequiresAnswer(screen) {
    return screen?.answerRequired === true || getScreenAnswerSpec(screen).length > 0;
}

function getScreenRequiredAnswerQuestions(screen) {
    return (screen?.questions ?? []).filter((question) => question.answer?.required === true && question.answer?.type !== 'none');
}

function validateQuestionScreens(screens, challenge, { includeIntro = true } = {}) {
    const issues = [];

    for (const screen of screens ?? []) {
        const requiredAnswers = getScreenRequiredAnswerQuestions(screen);
        if (requiredAnswers.length > VERIFICATION_UI_LIMITS.modalInputs) {
            issues.push({
                screenIndex: screen.index,
                code: 'too_many_modal_inputs',
                message: `Screen ${screen.index + 1} has ${requiredAnswers.length} required answer inputs. Discord modals support at most ${VERIFICATION_UI_LIMITS.modalInputs}. Mark some questions separateStep:true.`,
            });
        }

    }
    if (challenge) issues.push(...validateQuestionScreenBudgets(challenge, screens, { includeIntro }));

    return issues;
}

function screenAllowsBack(session, targetScreenIndex) {
    if (session?.allowBack === false) return false;
    const currentScreenIndex = Number(session?.screenIndex ?? 0);
    if (!Number.isInteger(targetScreenIndex) || targetScreenIndex !== currentScreenIndex - 1) return false;
    const targetScreen = session?.screens?.[targetScreenIndex];
    return Boolean(targetScreen && !screenRequiresAnswer(targetScreen) && !session?.answeredScreenIndexes?.includes(targetScreen.index));
}

function getSubmittedValue(submittedValues, question) {
    if (submittedValues && typeof submittedValues === 'object' && !Array.isArray(submittedValues)) {
        return submittedValues[question.id] ?? submittedValues[question.answer?.type] ?? submittedValues.answer ?? submittedValues.positions;
    }
    return submittedValues;
}

function validateQuestionAnswer(question, submittedValue, questionAssets = {}) {
    const answer = question?.answer ?? DEFAULT_ANSWER;
    if (answer.required !== true) return { ok: true };
    return validateRequiredAnswer(answer, submittedValue, question, questionAssets);
}

function validateScreenAnswers(screen, submittedValues, questionAssets = {}) {
    for (const question of screen?.questions ?? []) {
        const assets = questionAssets[question.id] ?? questionAssets;
        const result = validateQuestionAnswer(question, getSubmittedValue(submittedValues, question), assets);
        if (!result.ok) return { ...result, questionId: question.id };
    }
    return { ok: true };
}

module.exports = {
    normalizeVerificationChallenge,
    getChallengeQuestions,
    getQuestionNumber,
    resolveQuestion,
    buildQuestionScreens,
    screenRequiresAnswer,
    getScreenRequiredAnswerQuestions,
    validateQuestionScreens,
    screenAllowsBack,

    isSupportedRequiredAnswerType,
    validateScreenAnswers,

};
