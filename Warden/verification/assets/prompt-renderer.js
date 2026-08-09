const crypto = require('crypto');
const { pickRandomItem, shuffleArray } = require('../domain/questionTasks/shared/random');
const { assertPromptTextLength } = require('../domain/questionTasks/promptText');
const { getImageGenerationConfig } = require('./config');

const PROMPT_IMAGE_ATTACHMENT_NAME_PREFIX = 'warden-prompt';
const PROMPT_CANVAS_MAX_WIDTH = 2_048;
const PROMPT_CANVAS_MAX_HEIGHT = 2_048;
const PROMPT_CANVAS_MAX_PIXELS = 2_097_152;
const PROMPT_RENDER_TIMEOUT_MS = 10_000;

let canvasApi;
let discordApi;

function submitVerificationRenderJob(...args) {
    // The isolated child calls only renderPromptImageBuffer. Loading the pool
    // lazily here prevents that child from creating a nested supervisor.
    return require('./render-supervisor').submitVerificationRenderJob(...args);
}

function getCanvasApi() {
    if (!canvasApi) {
        canvasApi = require('@napi-rs/canvas');
    }

    return canvasApi;
}

function getDiscordApi() {
    if (!discordApi) discordApi = require('discord.js');
    return discordApi;
}

function randomBetween(min, max) {
    return min + (Math.random() * (max - min));
}

function lerp(start, end, amount) {
    return start + ((end - start) * amount);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function formatCanvasFontFamily(fontFamily) {
    return /\s/.test(fontFamily) ? `"${fontFamily.replace(/"/g, '')}"` : fontFamily;
}

function createPromptImageNonce() {
    return crypto.randomBytes(12).toString('hex');
}

function buildPromptImageAttachmentName() {
    return `${PROMPT_IMAGE_ATTACHMENT_NAME_PREFIX}-${createPromptImageNonce()}.png`;
}

function assertSafePromptCanvasDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height)
        || width < 1 || height < 1
        || width > PROMPT_CANVAS_MAX_WIDTH
        || height > PROMPT_CANVAS_MAX_HEIGHT
        || width * height > PROMPT_CANVAS_MAX_PIXELS) {
        throw new Error(`Prompt image canvas ${width}x${height} exceeds the safe rendering limit.`);
    }
}

function wrapCanvasText(context, text, maxWidth) {
    const words = String(text ?? '').split(/\s+/).filter(Boolean);
    const lines = [];
    let currentLine = '';

    for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (context.measureText(testLine).width <= maxWidth || !currentLine) {
            currentLine = testLine;
        }
        else {
            lines.push(currentLine);
            currentLine = word;
        }
    }

    if (currentLine) {
        lines.push(currentLine);
    }

    return lines.length > 0 ? lines : [''];
}

function pickPromptImagePalette(promptConfig) {
    return promptConfig.palettes[Math.floor(Math.random() * promptConfig.palettes.length)];
}

function drawPromptBackgroundPattern(context, width, height, palette, promptConfig) {
    const patternConfig = promptConfig.backgroundPattern;
    if (!patternConfig?.enabled) return;

    const tileSize = Math.max(18, patternConfig.tileSize);
    const motifSize = Math.min(patternConfig.motifSize, tileSize / 3);
    const offsetStep = (width + height) / Math.max(1, patternConfig.gridLineCount);
    const motifColumns = Math.ceil(width / tileSize) + 1;
    const motifRows = Math.ceil(height / tileSize) + 1;

    context.save();
    context.globalAlpha = patternConfig.alpha;
    context.lineCap = 'round';
    context.lineJoin = 'round';

    for (let index = 0; index < patternConfig.gridLineCount; index += 1) {
        const offset = index * offsetStep;
        context.strokeStyle = palette.curve[index % palette.curve.length];
        context.lineWidth = index % 3 === 0 ? 1.4 : 0.8;
        context.beginPath();
        context.moveTo(offset - height, 0);
        context.lineTo(offset, height);
        context.stroke();

        if (index % 2 === 0) {
            context.strokeStyle = palette.glyph[index % palette.glyph.length];
            context.beginPath();
            context.moveTo(width - offset + height, 0);
            context.lineTo(width - offset, height);
            context.stroke();
        }
    }

    for (let row = 0; row < motifRows; row += 1) {
        for (let column = 0; column < motifColumns; column += 1) {
            const x = (column * tileSize) + ((row % 2) * tileSize / 2);
            const y = row * tileSize;
            const motifIndex = row + column;

            context.strokeStyle = motifIndex % 2 === 0 ? palette.glyph[motifIndex % palette.glyph.length] : palette.curve[motifIndex % palette.curve.length];
            context.lineWidth = 1;
            context.beginPath();
            context.moveTo(x, y - motifSize);
            context.lineTo(x + motifSize, y);
            context.lineTo(x, y + motifSize);
            context.lineTo(x - motifSize, y);
            context.closePath();
            context.stroke();
        }
    }

    for (let index = 0; index < patternConfig.ringCount; index += 1) {
        const radiusStep = Math.max(motifSize * 1.5, Math.min(width, height) / Math.max(1, patternConfig.ringCount));
        const radius = motifSize + (index * radiusStep * 0.65);
        const x = (index % 2 === 0) ? width * 0.2 : width * 0.8;
        const y = (index % 3 === 0) ? height * 0.22 : height * 0.78;

        context.strokeStyle = index % 2 === 0 ? palette.curve[index % palette.curve.length] : palette.glyph[index % palette.glyph.length];
        context.lineWidth = index % 4 === 0 ? 1.2 : 0.7;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.stroke();
    }

    for (let index = 0; index < patternConfig.microLineCount; index += 1) {
        const column = index % Math.max(1, Math.ceil(width / (tileSize / 2)));
        const row = Math.floor(index / Math.max(1, Math.ceil(width / (tileSize / 2))));
        const x = (column * tileSize / 2) + ((row % 2) * motifSize);
        const y = (row * tileSize / 2) % (height + tileSize);
        const hatchLength = motifSize * 1.4;

        context.strokeStyle = index % 2 === 0 ? palette.curve[0] : palette.glyph[0];
        context.lineWidth = 0.8;
        context.beginPath();
        context.moveTo(x - hatchLength / 2, y - hatchLength / 2);
        context.lineTo(x + hatchLength / 2, y + hatchLength / 2);
        context.stroke();
    }

    context.restore();
}

function drawPromptImageNoise(context, width, height, promptConfig) {
    for (let index = 0; index < promptConfig.pixelNoiseCount; index += 1) {
        context.fillStyle = Math.random() > 0.5 ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.20)';
        context.fillRect(Math.random() * width, Math.random() * height, 1 + Math.random() * 4, 1 + Math.random() * 4);
    }
}

function drawPromptDecoyGlyphBatch(context, width, height, palette, promptConfig, count) {
    const glyphs = promptConfig.decoyGlyphs;
    const safeMarginX = Math.min(promptConfig.characterPositionMarginX, Math.floor(width / 2));
    const safeMarginY = Math.min(promptConfig.characterPositionMarginY, Math.floor(height / 2));
    const wavePhase = Math.random() * Math.PI * 2;

    for (let index = 0; index < count; index += 1) {
        const glyph = glyphs[Math.floor(Math.random() * glyphs.length)];
        const wave = Math.sin((index * promptConfig.textWaveFrequency) + wavePhase);
        const fontWeight = pickRandomItem(promptConfig.textFontWeights);
        const fontFamily = formatCanvasFontFamily(pickRandomItem(promptConfig.textFontFamilies));
        const fontSize = randomBetween(promptConfig.decoyGlyphSizeMin, promptConfig.decoyGlyphSizeMax);
        const rotation = randomBetween(-promptConfig.maxCharacterRotation, promptConfig.maxCharacterRotation) + (wave * promptConfig.textWaveRotation);
        const scaleX = Math.max(0.65, 1 + randomBetween(-promptConfig.characterScaleJitter, promptConfig.characterScaleJitter));
        const scaleY = Math.max(0.65, 1 + randomBetween(-promptConfig.characterScaleJitter, promptConfig.characterScaleJitter));
        const skewX = randomBetween(-promptConfig.characterSkewJitter, promptConfig.characterSkewJitter);
        const skewY = randomBetween(-promptConfig.characterSkewJitter, promptConfig.characterSkewJitter);
        const x = clamp(Math.random() * width, safeMarginX, width - safeMarginX);
        const y = clamp(
            (Math.random() * height) + (wave * promptConfig.textWaveAmplitude),
            safeMarginY,
            height - safeMarginY,
        );

        context.save();
        context.translate(x, y);
        context.rotate(rotation);
        context.transform(scaleX, skewY, skewX, scaleY, 0, 0);
        context.globalAlpha = randomBetween(promptConfig.decoyGlyphAlphaMin, promptConfig.decoyGlyphAlphaMax);
        context.font = `${fontWeight} ${fontSize}px ${fontFamily}, Arial, Helvetica, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = Math.random() > 0.5
            ? pickRandomItem(promptConfig.textFillColors)
            : pickRandomItem(palette.glyph);
        context.fillText(glyph, 0, 0);
        context.restore();
    }
}

function getJitteredDecoyGlyphCount(promptConfig) {
    const baseCount = Math.max(0, Math.round(promptConfig.decoyGlyphCount));
    const jitter = promptConfig.decoyGlyphCountJitterRatio;
    const min = Math.max(0, Math.round(baseCount * (1 - jitter)));
    const max = Math.max(min, Math.round(baseCount * (1 + jitter)));

    return Math.floor(randomBetween(min, max + 1));
}

function splitCountIntoThreeBatches(totalCount) {
    const first = Math.floor(Math.random() * (totalCount + 1));
    const remainingAfterFirst = totalCount - first;
    const second = Math.floor(Math.random() * (remainingAfterFirst + 1));
    const third = totalCount - first - second;

    return shuffleArray([first, second, third]);
}

function drawPromptLargeDecoyGlyphs(context, width, height, palette, promptConfig) {
    const largeDecoyConfig = promptConfig.largeDecoyGlyphs;
    if (!largeDecoyConfig?.enabled || largeDecoyConfig.count < 1) return;

    const glyphs = promptConfig.decoyGlyphs;
    const centerX = width / 2;
    const centerY = height / 2;
    const spreadX = width * (1 - largeDecoyConfig.centerBias);
    const spreadY = height * (1 - largeDecoyConfig.centerBias);

    for (let index = 0; index < largeDecoyConfig.count; index += 1) {
        const glyph = glyphs[Math.floor(Math.random() * glyphs.length)];
        const fontWeight = pickRandomItem(promptConfig.textFontWeights);
        const fontFamily = formatCanvasFontFamily(pickRandomItem(promptConfig.textFontFamilies));
        const x = clamp(
            centerX + (randomBetween(-width * 0.42, width * 0.42) * largeDecoyConfig.centerBias) + randomBetween(-spreadX, spreadX),
            width * 0.12,
            width * 0.88,
        );
        const y = clamp(
            centerY + (randomBetween(-height * 0.30, height * 0.30) * largeDecoyConfig.centerBias) + randomBetween(-spreadY, spreadY),
            height * 0.20,
            height * 0.82,
        );

        context.save();
        context.translate(x, y);
        context.rotate(randomBetween(-largeDecoyConfig.rotationMax, largeDecoyConfig.rotationMax));
        context.globalAlpha = randomBetween(largeDecoyConfig.alphaMin, largeDecoyConfig.alphaMax);
        context.font = `${fontWeight} ${randomBetween(largeDecoyConfig.sizeMin, largeDecoyConfig.sizeMax)}px ${fontFamily}, Arial, Helvetica, sans-serif`;
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillStyle = Math.random() > 0.5
            ? pickRandomItem(palette.glyph)
            : pickRandomItem(palette.curve);
        context.fillText(glyph, 0, 0);
        context.restore();
    }
}

function getObfuscationLineAlphaForWidth(lineWidth, promptConfig) {
    const minWidth = promptConfig.obfuscationLineWidthMin;
    const maxWidth = Math.max(minWidth, promptConfig.obfuscationLineWidthMax);
    const widthRatio = maxWidth === minWidth
        ? 1
        : clamp((lineWidth - minWidth) / (maxWidth - minWidth), 0, 1);
    const thinAlpha = promptConfig.obfuscationLineThinAlphaMax;
    const thickAlpha = Math.min(promptConfig.obfuscationLineThickAlphaMax, thinAlpha);
    const maxAlpha = lerp(thinAlpha, thickAlpha, widthRatio);

    return randomBetween(maxAlpha * 0.55, maxAlpha);
}

function getAggressiveObfuscationAngle(promptConfig) {
    const baseAngles = [-75, -58, -42, -28, 28, 42, 58, 75, 105, 122, 138, 152];

    return pickRandomItem(baseAngles) + randomBetween(
        -promptConfig.obfuscationLineAngleJitter,
        promptConfig.obfuscationLineAngleJitter,
    );
}

function drawPromptObfuscationLines(context, width, height, palette, promptConfig) {
    if (promptConfig.obfuscationLineCount < 1) return;

    const diagonal = Math.sqrt((width * width) + (height * height));
    const paletteColors = [
        ...palette.background,
        ...palette.curve,
        ...palette.glyph,
        ...promptConfig.textFillColors,
    ].filter(Boolean);

    for (let index = 0; index < promptConfig.obfuscationLineCount; index += 1) {
        const lineWidth = randomBetween(promptConfig.obfuscationLineWidthMin, promptConfig.obfuscationLineWidthMax);
        const alpha = getObfuscationLineAlphaForWidth(lineWidth, promptConfig);
        const angle = getAggressiveObfuscationAngle(promptConfig) * Math.PI / 180;
        const length = diagonal * randomBetween(1.05, 1.45);
        const centerX = randomBetween(width * 0.08, width * 0.92);
        const centerY = randomBetween(height * 0.08, height * 0.92);
        const dx = Math.cos(angle) * length / 2;
        const dy = Math.sin(angle) * length / 2;
        const curveAmount = promptConfig.obfuscationLineCurveAmount;

        context.save();
        context.globalAlpha = alpha;
        context.strokeStyle = pickRandomItem(paletteColors);
        context.lineWidth = lineWidth;
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.beginPath();
        context.moveTo(centerX - dx, centerY - dy);
        context.bezierCurveTo(
            centerX - (dx * 0.35) + randomBetween(-curveAmount, curveAmount),
            centerY - (dy * 0.35) + randomBetween(-curveAmount, curveAmount),
            centerX + (dx * 0.35) + randomBetween(-curveAmount, curveAmount),
            centerY + (dy * 0.35) + randomBetween(-curveAmount, curveAmount),
            centerX + dx,
            centerY + dy,
        );
        context.stroke();
        context.restore();
    }
}

function drawCharacterOcclusionLines(context, characterWidth, fontSize, palette, promptConfig) {
    const lineCount = Math.round(randomBetween(
        promptConfig.characterOcclusionLineCountMin,
        promptConfig.characterOcclusionLineCountMax,
    ));

    for (let index = 0; index < lineCount; index += 1) {
        const y = randomBetween(-fontSize * 0.42, fontSize * 0.34);
        const xPad = randomBetween(characterWidth * 0.18, characterWidth * 0.42);

        context.save();
        context.shadowColor = 'transparent';
        context.shadowBlur = 0;
        context.shadowOffsetX = 0;
        context.shadowOffsetY = 0;
        context.globalAlpha = randomBetween(
            promptConfig.characterOcclusionLineAlphaMin,
            promptConfig.characterOcclusionLineAlphaMax,
        );
        context.strokeStyle = Math.random() > 0.45
            ? pickRandomItem(palette.curve)
            : pickRandomItem(palette.glyph);
        context.lineWidth = randomBetween(
            promptConfig.characterOcclusionLineWidthMin,
            promptConfig.characterOcclusionLineWidthMax,
        );
        context.lineCap = 'round';
        context.lineJoin = 'round';

        context.beginPath();
        context.moveTo((-characterWidth / 2) - xPad, y);
        context.bezierCurveTo(
            -characterWidth * 0.18,
            y + randomBetween(-fontSize * 0.18, fontSize * 0.18),
            characterWidth * 0.18,
            y + randomBetween(-fontSize * 0.18, fontSize * 0.18),
            (characterWidth / 2) + xPad,
            y + randomBetween(-fontSize * 0.10, fontSize * 0.10),
        );
        context.stroke();
        context.restore();
    }
}

function drawPromptTextLine(context, line, centerX, centerY, palette, promptConfig, lineIndex = 0, canvasWidth = promptConfig.width, canvasHeight = promptConfig.minHeight) {
    const characters = [...line];
    const characterWidths = characters.map((character) => context.measureText(character).width);
    const overlaps = characters.map((character, index) => {
        const nextCharacter = characters[index + 1];

        if (
            !promptConfig.characterOverlapEnabled
            || index >= characters.length - 1
            || character === ' '
            || nextCharacter === ' '
            || Math.random() > promptConfig.characterOverlapChance
        ) {
            return 0;
        }

        return randomBetween(promptConfig.characterOverlapMin, promptConfig.characterOverlapMax);
    });
    const totalWidth = characterWidths.reduce((sum, width, index) => sum + width - overlaps[index], 0);
    const wavePhase = Math.random() * Math.PI * 2 + lineIndex;
    let currentX = centerX - (totalWidth / 2);

    characters.forEach((character, index) => {
        const characterWidth = characterWidths[index];
        const wave = Math.sin((index * promptConfig.textWaveFrequency) + wavePhase);
        const spacingJitter = randomBetween(-promptConfig.characterSpacingJitter, promptConfig.characterSpacingJitter);
        const rawX = currentX + (characterWidth / 2) + randomBetween(-promptConfig.characterJitter, promptConfig.characterJitter);
        const rawY = centerY + (wave * promptConfig.textWaveAmplitude) + randomBetween(-promptConfig.characterJitter, promptConfig.characterJitter);
        const safeMarginX = Math.min(promptConfig.characterPositionMarginX, Math.floor(canvasWidth / 2));
        const safeMarginY = Math.min(promptConfig.characterPositionMarginY, Math.floor(canvasHeight / 2));
        const x = clamp(rawX, safeMarginX, canvasWidth - safeMarginX);
        const y = clamp(rawY, safeMarginY, canvasHeight - safeMarginY);
        const fontSize = promptConfig.fontSize + randomBetween(-promptConfig.fontSizeJitter, promptConfig.fontSizeJitter);
        const rotation = randomBetween(-promptConfig.maxCharacterRotation, promptConfig.maxCharacterRotation) + (wave * promptConfig.textWaveRotation);
        const scaleX = 1 + randomBetween(-promptConfig.characterScaleJitter, promptConfig.characterScaleJitter);
        const scaleY = 1 + randomBetween(-promptConfig.characterScaleJitter, promptConfig.characterScaleJitter);
        const safeScaleX = Math.max(0.65, scaleX);
        const safeScaleY = Math.max(0.65, scaleY);
        const skewX = randomBetween(-promptConfig.characterSkewJitter, promptConfig.characterSkewJitter);
        const skewY = randomBetween(-promptConfig.characterSkewJitter, promptConfig.characterSkewJitter);
        const strokeWidth = randomBetween(promptConfig.textStrokeWidthMin, promptConfig.textStrokeWidthMax);
        const fontWeight = pickRandomItem(promptConfig.textFontWeights);
        const fontFamily = formatCanvasFontFamily(pickRandomItem(promptConfig.textFontFamilies));
        const fillColor = pickRandomItem(promptConfig.textFillColors);
        const shadowAlpha = randomBetween(promptConfig.textShadowAlphaMin, promptConfig.textShadowAlphaMax);

        context.save();
        context.translate(x, y);
        context.rotate(rotation);
        context.transform(safeScaleX, skewY, skewX, safeScaleY, 0, 0);
        context.font = `${fontWeight} ${fontSize}px ${fontFamily}, Arial, Helvetica, sans-serif`;
        context.globalAlpha = randomBetween(promptConfig.textAlphaMin, promptConfig.textAlphaMax);

        if (promptConfig.textShadowEnabled) {
            context.shadowColor = `rgba(0, 0, 0, ${shadowAlpha})`;
            context.shadowBlur = promptConfig.textShadowBlur;
            context.shadowOffsetX = randomBetween(-promptConfig.textShadowOffsetMax, promptConfig.textShadowOffsetMax);
            context.shadowOffsetY = randomBetween(-promptConfig.textShadowOffsetMax, promptConfig.textShadowOffsetMax);
        }
        else {
            context.shadowColor = 'transparent';
            context.shadowBlur = 0;
            context.shadowOffsetX = 0;
            context.shadowOffsetY = 0;
        }

        if (promptConfig.textOffsetShadowEnabled) {
            context.fillStyle = 'rgba(0, 0, 0, 0.42)';
            context.fillText(character, 3, 4);
        }

        if (promptConfig.textStrokeEnabled && strokeWidth > 0 && promptConfig.textStrokeAlphaMax > 0) {
            context.shadowBlur = 0;
            context.shadowOffsetX = 0;
            context.shadowOffsetY = 0;
            context.fillStyle = palette.stroke;
            context.globalAlpha = randomBetween(promptConfig.textStrokeAlphaMin, promptConfig.textStrokeAlphaMax);
            context.fillText(character, randomBetween(-strokeWidth, strokeWidth), randomBetween(-strokeWidth, strokeWidth));
        }

        context.globalAlpha = randomBetween(promptConfig.textFillAlphaMin, promptConfig.textFillAlphaMax);
        context.fillStyle = fillColor;
        context.fillText(character, 0, 0);
        drawCharacterOcclusionLines(context, characterWidth, fontSize, palette, promptConfig);
        context.restore();

        currentX += characterWidth - overlaps[index] + spacingJitter;
    });
}

function applyPromptImageDistortion(context, width, height, promptConfig) {
    const distortionConfig = promptConfig.distortion;
    if (!distortionConfig?.enabled) return;

    const source = context.getImageData(0, 0, width, height);
    const output = context.createImageData(width, height);
    const sourceData = source.data;
    const outputData = output.data;

    for (let y = 0; y < height; y += 1) {
        const rowShift = Math.round(Math.sin(y * distortionConfig.rowShiftFrequency) * distortionConfig.rowShiftAmplitude);

        for (let x = 0; x < width; x += 1) {
            const columnShift = Math.round(Math.sin(x * distortionConfig.columnShiftFrequency) * distortionConfig.columnShiftAmplitude);
            const sourceX = clamp(x + rowShift, 0, width - 1);
            const sourceY = clamp(y + columnShift, 0, height - 1);
            const sourceIndex = ((sourceY * width) + sourceX) * 4;
            const outputIndex = ((y * width) + x) * 4;

            outputData[outputIndex] = sourceData[sourceIndex];
            outputData[outputIndex + 1] = sourceData[sourceIndex + 1];
            outputData[outputIndex + 2] = sourceData[sourceIndex + 2];
            outputData[outputIndex + 3] = sourceData[sourceIndex + 3];
        }
    }

    context.putImageData(output, 0, 0);
}

function applyPromptFinalWaveDistortion(context, width, height, promptConfig) {
    const waveConfig = promptConfig.distortion?.finalWave;
    if (!waveConfig?.enabled || waveConfig.amplitude <= 0 || waveConfig.frequency <= 0) return;

    const phase = waveConfig.phaseJitter ? Math.random() * Math.PI * 2 : 0;
    const source = context.getImageData(0, 0, width, height);
    const output = context.createImageData(width, height);
    const sourceData = source.data;
    const outputData = output.data;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const verticalShift = Math.round(Math.sin((x * waveConfig.frequency) + phase) * waveConfig.amplitude);
            const sourceX = x;
            const sourceY = clamp(y + verticalShift, 0, height - 1);
            const sourceIndex = ((sourceY * width) + sourceX) * 4;
            const outputIndex = ((y * width) + x) * 4;

            outputData[outputIndex] = sourceData[sourceIndex];
            outputData[outputIndex + 1] = sourceData[sourceIndex + 1];
            outputData[outputIndex + 2] = sourceData[sourceIndex + 2];
            outputData[outputIndex + 3] = sourceData[sourceIndex + 3];
        }
    }

    context.putImageData(output, 0, 0);
}

function drawPromptCutouts(context, width, height, promptConfig) {
    if (promptConfig.cutoutCount < 1 || promptConfig.cutoutAlpha <= 0) return;

    context.save();
    context.globalCompositeOperation = 'destination-out';
    context.globalAlpha = promptConfig.cutoutAlpha;

    for (let index = 0; index < promptConfig.cutoutCount; index += 1) {
        context.beginPath();
        context.arc(
            Math.random() * width,
            Math.random() * height,
            randomBetween(promptConfig.cutoutRadiusMin, promptConfig.cutoutRadiusMax),
            0,
            Math.PI * 2,
        );
        context.fill();
    }

    context.restore();
    context.globalCompositeOperation = 'source-over';
}

function createPromptTextDrawOperation(context, lines, promptConfig, height, palette) {
    return () => {
        context.font = `700 ${promptConfig.fontSize}px Arial, Helvetica, sans-serif`;
        context.textBaseline = 'middle';
        context.textAlign = 'center';

        const startY = (height - ((lines.length - 1) * promptConfig.lineHeight)) / 2;
        lines.forEach((line, index) => {
            const y = startY + (index * promptConfig.lineHeight);
            const x = promptConfig.width / 2;
            drawPromptTextLine(context, line, x, y, palette, promptConfig, index, promptConfig.width, height);
        });
    };
}

async function renderPromptImageBuffer(prompt, promptConfig) {
    const { createCanvas } = getCanvasApi();
    assertSafePromptCanvasDimensions(promptConfig.width, promptConfig.minHeight);
    const measureCanvas = createCanvas(promptConfig.width, promptConfig.minHeight);
    const measureContext = measureCanvas.getContext('2d');
    measureContext.font = `700 ${promptConfig.fontSize}px Arial, Helvetica, sans-serif`;
    const maxTextWidth = Math.max(1, promptConfig.width - (promptConfig.padding * 2));
    const lines = wrapCanvasText(measureContext, prompt, maxTextWidth);
    const height = Math.max(promptConfig.minHeight, (promptConfig.padding * 2) + (lines.length * promptConfig.lineHeight));
    assertSafePromptCanvasDimensions(promptConfig.width, height);
    const canvas = createCanvas(promptConfig.width, height);
    const context = canvas.getContext('2d');

    const palette = pickPromptImagePalette(promptConfig);

    if (promptConfig.backgroundFillEnabled) {
        const gradient = context.createLinearGradient(0, 0, promptConfig.width, height);
        gradient.addColorStop(0, palette.background[0]);
        gradient.addColorStop(0.5, palette.background[1]);
        gradient.addColorStop(1, palette.background[2]);
        context.fillStyle = gradient;
        context.fillRect(0, 0, promptConfig.width, height);
    }

    drawPromptBackgroundPattern(context, promptConfig.width, height, palette, promptConfig);
    drawPromptImageNoise(context, promptConfig.width, height, promptConfig);

    const decoyCount = getJitteredDecoyGlyphCount(promptConfig);
    const decoyBatches = splitCountIntoThreeBatches(decoyCount);
    const textOperation = createPromptTextDrawOperation(context, lines, promptConfig, height, palette);
    const textInsertIndex = Math.floor(Math.random() * 4);
    const drawLargeDecoysBeforeTextBlock = Math.random() > 0.5;

    if (drawLargeDecoysBeforeTextBlock) {
        drawPromptLargeDecoyGlyphs(context, promptConfig.width, height, palette, promptConfig);
    }

    for (let stageIndex = 0; stageIndex < 4; stageIndex += 1) {
        if (stageIndex === textInsertIndex) {
            textOperation();
        }

        if (stageIndex < 3 && decoyBatches[stageIndex] > 0) {
            drawPromptDecoyGlyphBatch(
                context,
                promptConfig.width,
                height,
                palette,
                promptConfig,
                decoyBatches[stageIndex],
            );
        }
    }

    if (!drawLargeDecoysBeforeTextBlock) {
        drawPromptLargeDecoyGlyphs(context, promptConfig.width, height, palette, promptConfig);
    }

    applyPromptImageDistortion(context, promptConfig.width, height, promptConfig);
    applyPromptFinalWaveDistortion(context, promptConfig.width, height, promptConfig);
    drawPromptCutouts(context, promptConfig.width, height, promptConfig);
    drawPromptObfuscationLines(context, promptConfig.width, height, palette, promptConfig);

    return canvas.encode('png');
}

async function createPromptImageAttachment(prompt, { priority = 'live', signal } = {}) {
    const promptText = assertPromptTextLength(prompt);
    const { prompt: promptConfig } = getImageGenerationConfig();
    assertSafePromptCanvasDimensions(promptConfig.width, promptConfig.minHeight);
    const result = await submitVerificationRenderJob(
        'prompt',
        { prompt: promptText, config: promptConfig },
        {
            priority,
            signal,
            timeoutMs: PROMPT_RENDER_TIMEOUT_MS,
            label: 'Rendering verification prompt image',
        },
    );
    const name = buildPromptImageAttachmentName();
    const buffer = result.buffers[0];
    if (!buffer) throw new Error('Verification prompt process returned no image.');

    return {
        displayUrl: `attachment://${name}`,
        attachment: new (getDiscordApi().AttachmentBuilder)(buffer, { name }),
    };
}

module.exports = {
    createPromptImageAttachment,
    renderPromptImageBuffer,
};
