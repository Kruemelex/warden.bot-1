/**
 * Static verification challenge definitions only.
 *
 * Parent challenge fields describe challenge-level metadata: id, title,
 * description, fields, and questions. Verification logic belongs inside each
 * question through generatedImage and answer settings. Runtime normalization,
 * screen planning, and validation live in challenges.js; the catalog repository
 * seeds these protected templates into the database.
 */
const DEFAULT_CHALLENGE_ID = 'placeholder';

const rotationAlignmentConfig = {
    clockPositionDegrees: [0, 45, 90, 135, 180, 225, 270, 315],
    maxImageOrientationRepeats: 2,
    rotationDegrees: [0, 45, 90, 135, 180, 225, 270, 315],
    alignmentRule: {
        centerTargetOffsetDegrees: 0,
        outerTargetOffsetDegrees: 180,
    },
};

const verificationChallenges = {
    [DEFAULT_CHALLENGE_ID]: {
        id: DEFAULT_CHALLENGE_ID,
        title: 'Verification Challenge',
        description: 'Type the required verification text.',
        fields: [
            {
                title: 'Answer format',
                content: 'Enter the three letters shown in the prompt.',
                inline: false,
            },
        ],
        questions: [
            {
                id: 'axi-text',
                label: 'Question 1',
                text: 'Type "AXI" to verify.',
                separateStep: false,
                generatedImage: { enabled: false, type: 'none' },
                answer: {
                    required: true,
                    type: 'text',
                    accepted: ['axi'],
                    inputLabel: 'Verification answer',
                    inputPlaceholder: 'Enter the three letters shown in the prompt.',
                },
            },
        ],
    },
    eliteVesselGalleryEnhanced: {
        id: 'eliteVesselGalleryEnhanced',
        title: 'Verification Challenge',
        description: 'Answer both questions below.',
        questions: [
            {
                id: 'configured-object-name',
                label: 'Question 1',
                text: 'What is the name of the following object from Elite Dangerous?',
                separateStep: false,
                generatedImage: {
                    enabled: true,
                    type: 'prompt-text',
                },
                answer: {
                    required: true,
                    type: 'text',
                    inputLabel: 'Verification answer',
                    inputPlaceholder: 'Enter the object name',
                },
            },
            {
                id: 'configured-object-gallery',
                label: 'Question 2',
                text: 'Find all images depicting the object we are looking for. It may be multiple. Remember their tag number.',
                separateStep: true,
                generatedImage: {
                    enabled: true,
                    type: 'gallery-standard',
                    gallerySize: 9,
                    compositeImageGallery: true,
                    solutionImageCount: { max: 2 },
                    maxControlImageRepeats: 2,
                },
                answer: {
                    required: true,
                    type: 'positions',
                },
            },
        ],
    },
    onTheBlueDanube: {
        id: 'onTheBlueDanube',
        title: 'Verification Challenge',
        description: 'Look carefully at the generated imagery.',
        questions: [
            {
                id: 'danube-prompt-text',
                label: 'Question 1',
                text: 'Which image shows its objects perfectly aligned to [...] ?',
                separateStep: false,
                generatedImage: {
                    enabled: true,
                    type: 'prompt-text',
                },
                answer: {
                    required: true,
                    type: 'text',
                    inputLabel: 'Verification answer',
                    inputPlaceholder: 'Repeat what is written in the first image.',
                },
            },
            {
                id: 'danube-rotation-gallery',
                label: 'Question 2',
                text: 'Find what we are looking for. Note the tag number.',
                separateStep: false,
                generatedImage: {
                    enabled: true,
                    type: 'gallery-rotation-alignment',
                    gallerySize: 6,
                    compositeImageGallery: true,
                    solutionImageCount: { max: 1 },
                    rotationAlignment: rotationAlignmentConfig,
                },
                answer: {
                    required: true,
                    type: 'positions',
                },
            },
        ],
    },
};

module.exports = {
    verificationChallenges,
};
