const imageGenerationConfig = require('./config.json');

const DEFAULT_IMAGE_GENERATION_CONFIG = imageGenerationConfig;

function invalidImageGenerationConfig(path, expectation) {
    const error = new Error(
        `Invalid verification image configuration at "${path}" in assets/config.json: expected ${expectation}.`,
    );
    error.code = 'VERIFICATION_IMAGE_CONFIG_INVALID';
    return error;
}

function requireConfigObject(value, path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw invalidImageGenerationConfig(path, 'an object');
    }
    return value;
}

function getNumericValue(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string' && value.trim().length > 0) return Number(value);
    return Number.NaN;
}

function getPositiveInteger(value, fallback) {
    const numericValue = getNumericValue(value);

    if (Number.isInteger(numericValue) && numericValue >= 1) return numericValue;
    const numericFallback = getNumericValue(fallback);
    return Number.isInteger(numericFallback) && numericFallback >= 1
        ? numericFallback
        : undefined;
}

function getNonNegativeInteger(value, fallback) {
    const numericValue = getNumericValue(value);

    if (Number.isInteger(numericValue) && numericValue >= 0) return numericValue;
    const numericFallback = getNumericValue(fallback);
    return Number.isInteger(numericFallback) && numericFallback >= 0
        ? numericFallback
        : undefined;
}

function getNonNegativeNumber(value, fallback) {
    const numericValue = getNumericValue(value);

    if (Number.isFinite(numericValue) && numericValue >= 0) return numericValue;
    const numericFallback = getNumericValue(fallback);
    return Number.isFinite(numericFallback) && numericFallback >= 0
        ? numericFallback
        : undefined;
}

function getString(value, fallback) {
    if (typeof value === 'string' && value.length > 0) return value;
    return typeof fallback === 'string' && fallback.length > 0
        ? fallback
        : undefined;
}

function getBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    return typeof fallback === 'boolean' ? fallback : undefined;
}

function getBoundedNumber(value, fallback, min, max) {
    const numericValue = getNumericValue(value);
    const resolvedValue = Number.isFinite(numericValue)
        ? numericValue
        : getNumericValue(fallback);
    if (!Number.isFinite(resolvedValue)) return undefined;
    return Math.min(max, Math.max(min, resolvedValue));
}

function getNumberRange(minValue, maxValue, fallbackMin, fallbackMax, minAllowed, maxAllowed) {
    const min = getBoundedNumber(minValue, fallbackMin, minAllowed, maxAllowed);
    const max = getBoundedNumber(maxValue, fallbackMax, minAllowed, maxAllowed);

    return {
        min: Math.min(min, max),
        max: Math.max(min, max),
    };
}

function getStringArray(value, fallback, minimumLength = 1) {
    const normalize = (candidate) => {
        if (!Array.isArray(candidate)) return undefined;
        const strings = candidate.filter((item) => typeof item === 'string' && item.length > 0);
        return strings.length >= minimumLength ? strings : undefined;
    };
    return normalize(value) ?? normalize(fallback);
}

function getPromptPalettes(value, fallback) {
    const normalize = (candidate) => {
        if (!Array.isArray(candidate)) return undefined;
        const palettes = candidate
            .map((palette) => {
                if (!palette || typeof palette !== 'object') {
                    return undefined;
                }

                const background = getStringArray(palette.background, undefined, 3);
                const curve = getStringArray(palette.curve, undefined, 1);
                const glyph = getStringArray(palette.glyph, undefined, 1);
                const stroke = getString(palette.stroke, undefined);

                if (!background || !curve || !glyph || !stroke) {
                    return undefined;
                }

                return { background, curve, glyph, stroke };
            })
            .filter(Boolean);

        return palettes.length > 0 ? palettes : undefined;
    };
    return normalize(value) ?? normalize(fallback);
}

function assertResolvedImageGenerationConfig(value, path = 'imageGeneration') {
    if (value === undefined || value === null) {
        throw invalidImageGenerationConfig(path, 'a configured value');
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw invalidImageGenerationConfig(path, 'a finite number');
        }
        return;
    }
    if (typeof value === 'string') {
        if (value.length < 1) {
            throw invalidImageGenerationConfig(path, 'a non-empty string');
        }
        return;
    }
    if (typeof value === 'boolean') return;
    if (Array.isArray(value)) {
        if (value.length < 1) {
            throw invalidImageGenerationConfig(path, 'a non-empty array');
        }
        value.forEach((entry, index) =>
            assertResolvedImageGenerationConfig(entry, `${path}[${index}]`));
        return;
    }
    if (typeof value !== 'object') {
        throw invalidImageGenerationConfig(path, 'a supported JSON value');
    }
    const entries = Object.entries(value);
    if (entries.length < 1) {
        throw invalidImageGenerationConfig(path, 'a non-empty object');
    }
    for (const [key, entry] of entries) {
        assertResolvedImageGenerationConfig(entry, `${path}.${key}`);
    }
}

function normalizeImageGenerationConfig(configured) {
    configured = configured ?? {};
    const defaultGallery = requireConfigObject(DEFAULT_IMAGE_GENERATION_CONFIG.gallery, 'gallery');
    const defaultComposite = requireConfigObject(defaultGallery.composite, 'gallery.composite');
    const defaultRotationAlignmentTile = requireConfigObject(
        defaultGallery.rotationAlignmentTile,
        'gallery.rotationAlignmentTile',
    );
    const defaultPrompt = requireConfigObject(DEFAULT_IMAGE_GENERATION_CONFIG.prompt, 'prompt');
    const gallery = configured.gallery ?? {};
    const composite = gallery.composite ?? {};
    const rotationAlignmentTile = gallery.rotationAlignmentTile ?? {};
    const prompt = configured.prompt ?? {};
    const promptDistortion = prompt.distortion ?? {};
    const promptBackgroundPattern = prompt.backgroundPattern ?? {};
    const defaultDistortion = requireConfigObject(defaultPrompt.distortion, 'prompt.distortion');
    const promptFinalWave = promptDistortion.finalWave ?? {};
    const defaultFinalWave = requireConfigObject(defaultDistortion.finalWave, 'prompt.distortion.finalWave');
    const promptLargeDecoys = prompt.largeDecoyGlyphs ?? {};
    const defaultLargeDecoys = requireConfigObject(defaultPrompt.largeDecoyGlyphs, 'prompt.largeDecoyGlyphs');
    const defaultBackgroundPattern = requireConfigObject(defaultPrompt.backgroundPattern, 'prompt.backgroundPattern');
    const textStrokeWidth = getNumberRange(prompt.textStrokeWidthMin, prompt.textStrokeWidthMax, defaultPrompt.textStrokeWidthMin, defaultPrompt.textStrokeWidthMax, 0, 8);
    const textAlpha = getNumberRange(prompt.textAlphaMin, prompt.textAlphaMax, defaultPrompt.textAlphaMin, defaultPrompt.textAlphaMax, 0.4, 1);
    const textShadowAlpha = getNumberRange(prompt.textShadowAlphaMin, prompt.textShadowAlphaMax, defaultPrompt.textShadowAlphaMin, defaultPrompt.textShadowAlphaMax, 0, 1);
    const textStrokeAlpha = getNumberRange(prompt.textStrokeAlphaMin, prompt.textStrokeAlphaMax, defaultPrompt.textStrokeAlphaMin, defaultPrompt.textStrokeAlphaMax, 0, 1);
    const characterOverlap = getNumberRange(prompt.characterOverlapMin, prompt.characterOverlapMax, defaultPrompt.characterOverlapMin, defaultPrompt.characterOverlapMax, 0, 14);
    const characterOcclusionLineCount = getNumberRange(prompt.characterOcclusionLineCountMin, prompt.characterOcclusionLineCountMax, defaultPrompt.characterOcclusionLineCountMin, defaultPrompt.characterOcclusionLineCountMax, 0, 12);
    const characterOcclusionLineWidth = getNumberRange(prompt.characterOcclusionLineWidthMin, prompt.characterOcclusionLineWidthMax, defaultPrompt.characterOcclusionLineWidthMin, defaultPrompt.characterOcclusionLineWidthMax, 1, 22);
    const characterOcclusionLineAlpha = getNumberRange(prompt.characterOcclusionLineAlphaMin, prompt.characterOcclusionLineAlphaMax, defaultPrompt.characterOcclusionLineAlphaMin, defaultPrompt.characterOcclusionLineAlphaMax, 0, 1);
    const textFillAlpha = getNumberRange(prompt.textFillAlphaMin, prompt.textFillAlphaMax, defaultPrompt.textFillAlphaMin, defaultPrompt.textFillAlphaMax, 0.4, 1);
    const obfuscationLineWidth = getNumberRange(
        prompt.obfuscationLineWidthMin,
        prompt.obfuscationLineWidthMax,
        defaultPrompt.obfuscationLineWidthMin,
        defaultPrompt.obfuscationLineWidthMax,
        0.5,
        32,
    );
    const decoyGlyphAlpha = getNumberRange(prompt.decoyGlyphAlphaMin, prompt.decoyGlyphAlphaMax, defaultPrompt.decoyGlyphAlphaMin, defaultPrompt.decoyGlyphAlphaMax, 0, 0.6);
    const decoyGlyphSize = getNumberRange(prompt.decoyGlyphSizeMin, prompt.decoyGlyphSizeMax, defaultPrompt.decoyGlyphSizeMin, defaultPrompt.decoyGlyphSizeMax, 6, 96);
    const cutoutRadius = getNumberRange(prompt.cutoutRadiusMin, prompt.cutoutRadiusMax, defaultPrompt.cutoutRadiusMin, defaultPrompt.cutoutRadiusMax, 1, 14);
    const largeDecoyAlpha = getNumberRange(promptLargeDecoys.alphaMin, promptLargeDecoys.alphaMax, defaultLargeDecoys.alphaMin, defaultLargeDecoys.alphaMax, 0, 0.28);
    const largeDecoySize = getNumberRange(promptLargeDecoys.sizeMin, promptLargeDecoys.sizeMax, defaultLargeDecoys.sizeMin, defaultLargeDecoys.sizeMax, 48, 240);

    return {
        gallery: {
            composite: {
                tileSize: getPositiveInteger(composite.tileSize, defaultComposite.tileSize),
                labelPadding: getNonNegativeInteger(composite.labelPadding, defaultComposite.labelPadding),
                labelSize: getPositiveInteger(composite.labelSize, defaultComposite.labelSize),
            },
            rotationAlignmentTile: {
                width: getPositiveInteger(rotationAlignmentTile.width, defaultRotationAlignmentTile.width),
                height: getPositiveInteger(rotationAlignmentTile.height, defaultRotationAlignmentTile.height),
                background: getString(rotationAlignmentTile.background, defaultRotationAlignmentTile.background),
                centerScale: getBoundedNumber(rotationAlignmentTile.centerScale, defaultRotationAlignmentTile.centerScale, 0.01, 1),
                outerScale: getBoundedNumber(rotationAlignmentTile.outerScale, defaultRotationAlignmentTile.outerScale, 0.01, 1),
                outerRadius: getNonNegativeNumber(rotationAlignmentTile.outerRadius, defaultRotationAlignmentTile.outerRadius),
                glow: getBoolean(rotationAlignmentTile.glow, defaultRotationAlignmentTile.glow),
            },
        },
        prompt: {
            width: getPositiveInteger(prompt.width, defaultPrompt.width),
            minHeight: getPositiveInteger(prompt.minHeight, defaultPrompt.minHeight),
            padding: getNonNegativeInteger(prompt.padding, defaultPrompt.padding),
            fontSize: getPositiveInteger(prompt.fontSize, defaultPrompt.fontSize),
            lineHeight: getPositiveInteger(prompt.lineHeight, defaultPrompt.lineHeight),
            backgroundFillEnabled: getBoolean(prompt.backgroundFillEnabled, defaultPrompt.backgroundFillEnabled),
            pixelNoiseCount: getNonNegativeInteger(prompt.pixelNoiseCount, defaultPrompt.pixelNoiseCount),
            decoyGlyphs: getString(prompt.decoyGlyphs, defaultPrompt.decoyGlyphs),
            decoyGlyphCount: getNonNegativeInteger(prompt.decoyGlyphCount, defaultPrompt.decoyGlyphCount),
            decoyGlyphCountJitterRatio: getBoundedNumber(prompt.decoyGlyphCountJitterRatio, defaultPrompt.decoyGlyphCountJitterRatio, 0, 0.35),
            obfuscationLineCount: getNonNegativeInteger(prompt.obfuscationLineCount, defaultPrompt.obfuscationLineCount),
            obfuscationLineWidthMin: obfuscationLineWidth.min,
            obfuscationLineWidthMax: obfuscationLineWidth.max,
            obfuscationLineThinAlphaMax: getBoundedNumber(prompt.obfuscationLineThinAlphaMax, defaultPrompt.obfuscationLineThinAlphaMax, 0, 0.75),
            obfuscationLineThickAlphaMax: getBoundedNumber(prompt.obfuscationLineThickAlphaMax, defaultPrompt.obfuscationLineThickAlphaMax, 0, 0.5),
            obfuscationLineCurveAmount: getBoundedNumber(prompt.obfuscationLineCurveAmount, defaultPrompt.obfuscationLineCurveAmount, 0, 260),
            obfuscationLineAngleJitter: getBoundedNumber(prompt.obfuscationLineAngleJitter, defaultPrompt.obfuscationLineAngleJitter, 0, 45),
            maxCharacterRotation: getBoundedNumber(prompt.maxCharacterRotation, defaultPrompt.maxCharacterRotation, 0, 0.35),
            characterJitter: getBoundedNumber(prompt.characterJitter, defaultPrompt.characterJitter, 0, 14),
            textWaveAmplitude: getBoundedNumber(prompt.textWaveAmplitude, defaultPrompt.textWaveAmplitude, 0, 24),
            textWaveFrequency: getBoundedNumber(prompt.textWaveFrequency, defaultPrompt.textWaveFrequency, 0, 3),
            textWaveRotation: getBoundedNumber(prompt.textWaveRotation, defaultPrompt.textWaveRotation, 0, 0.25),
            characterScaleJitter: getBoundedNumber(prompt.characterScaleJitter, defaultPrompt.characterScaleJitter, 0, 0.22),
            characterSkewJitter: getBoundedNumber(prompt.characterSkewJitter, defaultPrompt.characterSkewJitter, 0, 0.18),
            characterSpacingJitter: getBoundedNumber(prompt.characterSpacingJitter, defaultPrompt.characterSpacingJitter, 0, 24),
            characterOverlapEnabled: getBoolean(prompt.characterOverlapEnabled, defaultPrompt.characterOverlapEnabled),
            characterOverlapChance: getBoundedNumber(prompt.characterOverlapChance, defaultPrompt.characterOverlapChance, 0, 1),
            characterOverlapMin: characterOverlap.min,
            characterOverlapMax: characterOverlap.max,
            characterPositionMarginX: getBoundedNumber(prompt.characterPositionMarginX, defaultPrompt.characterPositionMarginX, 0, 96),
            characterPositionMarginY: getBoundedNumber(prompt.characterPositionMarginY, defaultPrompt.characterPositionMarginY, 0, 96),
            fontSizeJitter: getBoundedNumber(prompt.fontSizeJitter, defaultPrompt.fontSizeJitter, 0, 9),
            textStrokeEnabled: getBoolean(prompt.textStrokeEnabled, defaultPrompt.textStrokeEnabled),
            textShadowEnabled: getBoolean(prompt.textShadowEnabled, defaultPrompt.textShadowEnabled),
            textOffsetShadowEnabled: getBoolean(prompt.textOffsetShadowEnabled, defaultPrompt.textOffsetShadowEnabled),
            textStrokeWidthMin: textStrokeWidth.min,
            textStrokeWidthMax: textStrokeWidth.max,
            textShadowBlur: getBoundedNumber(prompt.textShadowBlur, defaultPrompt.textShadowBlur, 0, 16),
            textShadowOffsetMax: getBoundedNumber(prompt.textShadowOffsetMax, defaultPrompt.textShadowOffsetMax, 0, 16),
            textShadowAlphaMin: textShadowAlpha.min,
            textShadowAlphaMax: textShadowAlpha.max,
            textAlphaMin: textAlpha.min,
            textAlphaMax: textAlpha.max,
            textStrokeAlphaMin: textStrokeAlpha.min,
            textStrokeAlphaMax: textStrokeAlpha.max,
            characterOcclusionLineCountMin: characterOcclusionLineCount.min,
            characterOcclusionLineCountMax: characterOcclusionLineCount.max,
            characterOcclusionLineWidthMin: characterOcclusionLineWidth.min,
            characterOcclusionLineWidthMax: characterOcclusionLineWidth.max,
            characterOcclusionLineAlphaMin: characterOcclusionLineAlpha.min,
            characterOcclusionLineAlphaMax: characterOcclusionLineAlpha.max,
            textFillAlphaMin: textFillAlpha.min,
            textFillAlphaMax: textFillAlpha.max,
            textFontWeights: getStringArray(prompt.textFontWeights, defaultPrompt.textFontWeights),
            textFontFamilies: getStringArray(prompt.textFontFamilies, defaultPrompt.textFontFamilies),
            textFillColors: getStringArray(prompt.textFillColors, defaultPrompt.textFillColors),
            decoyGlyphAlphaMin: decoyGlyphAlpha.min,
            decoyGlyphAlphaMax: decoyGlyphAlpha.max,
            decoyGlyphSizeMin: decoyGlyphSize.min,
            decoyGlyphSizeMax: decoyGlyphSize.max,
            largeDecoyGlyphs: {
                enabled: getBoolean(promptLargeDecoys.enabled, defaultLargeDecoys.enabled),
                count: getBoundedNumber(promptLargeDecoys.count, defaultLargeDecoys.count, 0, 8),
                alphaMin: largeDecoyAlpha.min,
                alphaMax: largeDecoyAlpha.max,
                sizeMin: largeDecoySize.min,
                sizeMax: largeDecoySize.max,
                rotationMax: getBoundedNumber(promptLargeDecoys.rotationMax, defaultLargeDecoys.rotationMax, 0, 1.2),
                centerBias: getBoundedNumber(promptLargeDecoys.centerBias, defaultLargeDecoys.centerBias, 0, 1),
            },
            cutoutCount: getBoundedNumber(prompt.cutoutCount, defaultPrompt.cutoutCount, 0, 60),
            cutoutRadiusMin: cutoutRadius.min,
            cutoutRadiusMax: cutoutRadius.max,
            cutoutAlpha: getBoundedNumber(prompt.cutoutAlpha, defaultPrompt.cutoutAlpha, 0, 0.7),
            backgroundPattern: {
                enabled: getBoolean(promptBackgroundPattern.enabled, defaultBackgroundPattern.enabled),
                gridLineCount: getBoundedNumber(promptBackgroundPattern.gridLineCount, defaultBackgroundPattern.gridLineCount, 0, 400),
                ringCount: getBoundedNumber(promptBackgroundPattern.ringCount, defaultBackgroundPattern.ringCount, 0, 400),
                microLineCount: getBoundedNumber(promptBackgroundPattern.microLineCount, defaultBackgroundPattern.microLineCount, 0, 400),
                tileSize: getBoundedNumber(promptBackgroundPattern.tileSize, defaultBackgroundPattern.tileSize, 18, 140),
                motifSize: getBoundedNumber(promptBackgroundPattern.motifSize, defaultBackgroundPattern.motifSize, 3, 28),
                alpha: getBoundedNumber(promptBackgroundPattern.alpha, defaultBackgroundPattern.alpha, 0, 0.5),
            },
            distortion: {
                enabled: getBoolean(promptDistortion.enabled, defaultDistortion.enabled),
                rowShiftAmplitude: getBoundedNumber(promptDistortion.rowShiftAmplitude, defaultDistortion.rowShiftAmplitude, 0, 30),
                rowShiftFrequency: getBoundedNumber(promptDistortion.rowShiftFrequency, defaultDistortion.rowShiftFrequency, 0, 0.2),
                columnShiftAmplitude: getBoundedNumber(promptDistortion.columnShiftAmplitude, defaultDistortion.columnShiftAmplitude, 0, 30),
                columnShiftFrequency: getBoundedNumber(promptDistortion.columnShiftFrequency, defaultDistortion.columnShiftFrequency, 0, 0.2),
                finalWave: {
                    enabled: getBoolean(promptFinalWave.enabled, defaultFinalWave.enabled),
                    amplitude: getBoundedNumber(promptFinalWave.amplitude, defaultFinalWave.amplitude, 0, 14),
                    frequency: getBoundedNumber(promptFinalWave.frequency, defaultFinalWave.frequency, 0, 0.12),
                    phaseJitter: getBoolean(promptFinalWave.phaseJitter, defaultFinalWave.phaseJitter),
                },
            },
            palettes: getPromptPalettes(prompt.palettes, defaultPrompt.palettes),
        },
    };
}

const normalizedImageGenerationConfig = normalizeImageGenerationConfig(imageGenerationConfig);
assertResolvedImageGenerationConfig(normalizedImageGenerationConfig);

function getImageGenerationConfig() {
    return normalizedImageGenerationConfig;
}

module.exports = {
    getImageGenerationConfig,
    getBoundedNumber,
};
