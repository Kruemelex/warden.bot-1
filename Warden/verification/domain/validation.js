const {
    normalizeVerificationChallenge,
    buildQuestionScreens,
    isSupportedRequiredAnswerType,
    validateQuestionScreens,
} = require('./challenges');
const { VERIFICATION_UI_LIMITS } = require('./limits');
const {
    getQuestionTaskModule,
    getQuestionTaskType,
} = require('./questionTasks/taskRegistry');
const { getAnswerTypeDescriptor, taskSupportsAnswerType } = require('./answerTypes');
const { getVerificationImageInventory } = require('../assets/image-inventory');

function createIssue({ code, challengeId, questionId = null, taskType = 'none', field = null, label, message, active = false }) {
    return { severity: 'blocking', code, challengeId, questionId, taskType, field, label, message, active };
}

function resolveConfiguredActiveChallengeIds(verificationSettings = {}) {
    if (Array.isArray(verificationSettings.activeChallengeIds) && verificationSettings.activeChallengeIds.length > 0) {
        return verificationSettings.activeChallengeIds.map(String);
    }
    return [];
}

function getQuestionScreenIssueLabel(issue) {
    if (issue.code === 'too_many_modal_inputs') return 'Screen answers';
    if (issue.code === 'challenge_introduction_field_limit') return 'Challenge information';
    return 'Discord screen limits';
}

function evaluateChallengeConfigIssues(challenge, activeChallengeIds = [], options = {}) {
    const activeSet = new Set(activeChallengeIds.map(String));
    const normalizedChallenge = normalizeVerificationChallenge(challenge);
    if (!normalizedChallenge) return [];
    const active = activeSet.has(String(normalizedChallenge.id));
    const includeIntro = options.includeIntro !== false;
    const screens = buildQuestionScreens(normalizedChallenge, { includeIntro });
    const issues = screens.length < 1 ? [createIssue({
        code: 'missing_questions',
        challengeId: normalizedChallenge.id,
        label: 'Questions',
        message: `${normalizedChallenge.id}: Verification challenge requires at least one question.`,
        active,
    })] : [];
    issues.push(...validateQuestionScreens(screens, normalizedChallenge, { includeIntro }).map((issue) => createIssue({
        code: issue.code ?? 'invalid_question_screen',
        challengeId: normalizedChallenge.id,
        questionId: null,
        label: getQuestionScreenIssueLabel(issue),
        message: issue.message,
        active,
    })));

    const questionIds = new Set();
    for (const question of normalizedChallenge.questions ?? []) {
        const questionId = String(question?.id ?? '').trim();
        if (!questionId) {
            issues.push(createIssue({
                code: 'missing_question_id',
                challengeId: normalizedChallenge.id,
                label: 'Question ID',
                message: `${normalizedChallenge.id}: A catalog question has no ID.`,
                active,
            }));
        }
        else if (questionIds.has(questionId)) {
            issues.push(createIssue({
                code: 'duplicate_question_id',
                challengeId: normalizedChallenge.id,
                questionId,
                label: 'Question ID',
                message: `${normalizedChallenge.id}: The catalog contains duplicate question ID "${questionId}".`,
                active,
            }));
        }
        else {
            questionIds.add(questionId);
        }
        const generatedImage = question.generatedImage ?? {};
        const answer = question.answer ?? {};
        const taskType = getQuestionTaskType(question);
        const prefix = `${normalizedChallenge.id}/${question.id}`;
        const base = { challengeId: normalizedChallenge.id, questionId: question.id, taskType, active };

        const taskModule = getQuestionTaskModule(question);
        const answerDescriptor = getAnswerTypeDescriptor(answer.type);
        if (!taskModule) {
            issues.push(createIssue({ ...base, code: 'unsupported_task_type', field: 'generatedImage.type', label: 'Task type', message: `${prefix}: Unsupported verification task type "${taskType}".` }));
        }
        if (answer.required === true && !isSupportedRequiredAnswerType(answer.type)) {
            issues.push(createIssue({ ...base, code: 'unsupported_answer_type', field: 'answer.type', label: 'Answer type', message: `${prefix}: Required verification answer type "${answer.type}" is unsupported.` }));
        }
        if (
            answer.required === true
            && answerDescriptor?.taskCapability
            && !taskSupportsAnswerType(taskModule, answer.type)
        ) {
            issues.push(createIssue({
                ...base,
                code: `${answer.type.replaceAll('-', '_')}_answer_requires_gallery`,
                field: 'answer.type',
                label: `${answerDescriptor.label} task`,
                message: `${prefix}: Required ${answerDescriptor.label} needs a gallery task that supports it.`,
            }));
        }
        if (answer.required === true && answerDescriptor?.editablePrompt && String(answer.inputLabel ?? '').length > VERIFICATION_UI_LIMITS.modalLabelLength) {
            issues.push(createIssue({ ...base, code: 'answer_input_label_too_long', field: 'answer.inputLabel', label: 'Answer input label', message: `${prefix}: Answer input label exceeds Discord's ${VERIFICATION_UI_LIMITS.modalLabelLength}-character limit.` }));
        }
        if (answer.required === true && answerDescriptor?.editablePrompt && String(answer.inputPlaceholder ?? '').length > VERIFICATION_UI_LIMITS.textInputPlaceholderLength) {
            issues.push(createIssue({ ...base, code: 'answer_input_placeholder_too_long', field: 'answer.inputPlaceholder', label: 'Answer input placeholder', message: `${prefix}: Answer input placeholder exceeds Discord's ${VERIFICATION_UI_LIMITS.textInputPlaceholderLength}-character limit.` }));
        }
        if (answer.required === true && answerDescriptor?.editableAcceptedAnswers && !answer.accepted?.length) {
            issues.push(createIssue({ ...base, code: 'missing_accepted_answers', field: 'answer.accepted', label: 'Accepted answers', message: `${prefix}: Required text answer needs at least one accepted answer.` }));
        }
        if (taskModule?.validateConfig) {
            const taskIssues = taskModule.validateConfig(question, {
                challengeId: normalizedChallenge.id,
                verificationImages: options.imageInventory ?? getVerificationImageInventory(),
            });
            issues.push(...taskIssues.map((taskIssue) => createIssue({ ...base, ...taskIssue })));
        }
    }
    return issues;
}

function evaluateVerificationConfigIssues(verificationSettings = {}, options = {}) {
    const activeChallengeIds = resolveConfiguredActiveChallengeIds(verificationSettings);
    const catalogChallenges = Array.isArray(verificationSettings.challenges)
        ? verificationSettings.challenges
        : undefined;

    if (catalogChallenges) {
        const catalogById = new Map(catalogChallenges.map((challenge) => [String(challenge.id), challenge]));
        const issues = catalogChallenges.flatMap((challenge) =>
            evaluateChallengeConfigIssues(challenge, activeChallengeIds, options));

        for (const challengeId of activeChallengeIds) {
            if (catalogById.has(String(challengeId))) continue;
            issues.push(createIssue({
                code: 'missing_active_challenge',
                challengeId: String(challengeId),
                label: 'Active challenge',
                message: `${challengeId}: Active verification challenge is missing from the authoritative catalog.`,
                active: true,
            }));
        }

        return issues;
    }

    return activeChallengeIds.map((challengeId) => createIssue({
        code: 'missing_active_challenge',
        challengeId,
        label: 'Active challenge',
        message: `${challengeId}: Active verification challenge is missing from the authoritative catalog.`,
        active: true,
    }));
}

function evaluateVerificationConfig(configuration = {}, options = {}) {
    const activeChallengeIds = resolveConfiguredActiveChallengeIds(configuration);
    const issues = evaluateVerificationConfigIssues(configuration, options).map((issue) => Object.freeze({
        ...issue,
        active: activeChallengeIds.includes(String(issue.challengeId)),
        changed: (!options.changedChallengeId || issue.challengeId === options.changedChallengeId)
            && (!options.changedQuestionId || issue.questionId === options.changedQuestionId),
    }));
    const blockingIssues = issues.filter((issue) => issue.severity === 'blocking');
    const activeBlockingIssues = blockingIssues.filter((issue) => issue.active);

    return Object.freeze({
        mode: configuration.mode,
        activeChallengeIds: Object.freeze([...activeChallengeIds]),
        issues: Object.freeze(issues),
        blockingIssues: Object.freeze(blockingIssues),
        activeBlockingIssues: Object.freeze(activeBlockingIssues),
        unsafeActiveChallengeIds: Object.freeze([...new Set(activeBlockingIssues.map((issue) => issue.challengeId))]),
    });
}

module.exports = {
    evaluateChallengeConfigIssues,
    evaluateVerificationConfig,
};
