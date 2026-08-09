const crypto = require('crypto');
const fs = require('fs/promises');
const { constants: fsConstants } = require('fs');
const path = require('path');
const { runVerificationImageRead } = require('../runtime/resource-admission');

const VERIFICATION_IMAGE_DIRECTORY = '/home/container/verificationImages';
const VERIFICATION_IMAGE_REFRESH_TTL_MS = 5_000;
const VERIFICATION_IMAGE_SCAN_TIMEOUT_MS = 5_000;
const VERIFICATION_IMAGE_READ_TIMEOUT_MS = 5_000;
const VERIFICATION_IMAGE_MAX_FILE_BYTES = 16 * 1024 * 1024;
const SUPPORTED_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp']);

let inventorySnapshot = Object.freeze({
    images: Object.freeze([]),
    byId: createReadonlyImageIndex([]),
    issues: Object.freeze(['Verification images have not been scanned yet.']),
    directory: VERIFICATION_IMAGE_DIRECTORY,
    scanSucceeded: false,
    contentRevision: 0,
    scannedAt: 0,
});
let refreshPromise;
const lastKnownGoodImagesByDirectory = new Map();
const imageContentFingerprintCache = new Map();

function createReadonlyImageIndex(images) {
    const index = new Map(images.map((image) => [image.id, image]));
    const failMutation = () => {
        throw new TypeError('Verification image inventories are immutable.');
    };

    for (const method of ['set', 'delete', 'clear']) {
        Object.defineProperty(index, method, {
            configurable: false,
            enumerable: false,
            value: failMutation,
            writable: false,
        });
    }

    return Object.freeze(index);
}

function compareImageNames(left, right) {
    return left.localeCompare(right, 'en', { numeric: true, sensitivity: 'base' });
}

function buildSnapshot(images, issues, directory, scanSucceeded) {
    const resolvedDirectory = path.resolve(directory);
    const normalizedImages = Object.freeze([...images].sort((left, right) => compareImageNames(left.id, right.id)));
    const normalizedIssues = Object.freeze([...new Set(issues.map(String))]);
    const previousContentSignature = JSON.stringify({
        directory: inventorySnapshot.directory,
        images: inventorySnapshot.images.map((image) => [
            image.id,
            image.size,
            image.contentSha256,
        ]),
    });
    const nextContentSignature = JSON.stringify({
        directory: resolvedDirectory,
        images: normalizedImages.map((image) => [
            image.id,
            image.size,
            image.contentSha256,
        ]),
    });
    const contentRevision = inventorySnapshot.contentRevision
        + (previousContentSignature === nextContentSignature ? 0 : 1);

    return Object.freeze({
        images: normalizedImages,
        byId: createReadonlyImageIndex(normalizedImages),
        issues: normalizedIssues,
        directory: resolvedDirectory,
        scanSucceeded,
        contentRevision,
        scannedAt: Date.now(),
    });
}

function retainLastKnownGoodImages(snapshot) {
    if (snapshot.scanSucceeded) {
        lastKnownGoodImagesByDirectory.set(snapshot.directory, snapshot.images);
        return snapshot;
    }

    const lastKnownGoodImages = lastKnownGoodImagesByDirectory.get(snapshot.directory);
    if (!lastKnownGoodImages) return snapshot;

    return buildSnapshot(
        lastKnownGoodImages,
        snapshot.issues,
        snapshot.directory,
        false,
    );
}

function getImageStatIdentity(stats) {
    return {
        size: stats.size,
        modifiedAtMs: stats.mtimeMs,
        changedAtMs: stats.ctimeMs,
        inode: String(stats.ino),
    };
}

function imageStatsMatchIdentity(stats, identity) {
    return stats.isFile()
        && stats.size === identity.size
        && stats.mtimeMs === identity.modifiedAtMs
        && stats.ctimeMs === identity.changedAtMs
        && String(stats.ino) === identity.inode;
}

function hasImageContentFingerprint(image) {
    return /^[a-f0-9]{64}$/i.test(String(image?.contentSha256 ?? ''));
}

function createInventoryChangedError(image, message) {
    const error = new Error(`Verification image ${image.id} ${message}`);
    error.code = 'VERIFICATION_IMAGE_INVENTORY_CHANGED';
    return error;
}

function getImageFingerprintCacheKey(filePath, identity) {
    return [
        filePath,
        identity.size,
        identity.modifiedAtMs,
        identity.changedAtMs,
        identity.inode,
    ].join('\u0000');
}

async function getVerificationImageContentSha256(filePath, identity) {
    const cacheKey = getImageFingerprintCacheKey(filePath, identity);
    const cached = imageContentFingerprintCache.get(cacheKey);
    if (cached) return cached;

    const handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
        const openedStats = await handle.stat();
        if (!imageStatsMatchIdentity(openedStats, identity)) {
            throw new Error('file changed before its content fingerprint was read');
        }
        if (openedStats.size > VERIFICATION_IMAGE_MAX_FILE_BYTES) {
            throw new Error(
                `file is ${openedStats.size} bytes; the limit is `
                + `${VERIFICATION_IMAGE_MAX_FILE_BYTES} bytes`,
            );
        }
        const abortController = new AbortController();
        let timer;
        const buffer = await Promise.race([
            handle.readFile({ signal: abortController.signal }),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    abortController.abort();
                    const error = new Error(
                        `timed out after ${VERIFICATION_IMAGE_READ_TIMEOUT_MS}ms`,
                    );
                    error.code = 'VERIFICATION_IMAGE_FINGERPRINT_TIMEOUT';
                    reject(error);
                }, VERIFICATION_IMAGE_READ_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]).finally(() => clearTimeout(timer));
        const completedStats = await handle.stat();
        if (!imageStatsMatchIdentity(completedStats, identity) || buffer.length !== identity.size) {
            throw new Error('file changed while its content fingerprint was read');
        }
        const fingerprint = crypto.createHash('sha256').update(buffer).digest('hex');
        const fileCachePrefix = `${filePath}\u0000`;
        for (const existingKey of imageContentFingerprintCache.keys()) {
            if (existingKey !== cacheKey && existingKey.startsWith(fileCachePrefix)) {
                imageContentFingerprintCache.delete(existingKey);
            }
        }
        imageContentFingerprintCache.set(cacheKey, fingerprint);
        return fingerprint;
    }
    finally {
        await handle.close();
    }
}

async function scanVerificationImages(directory = VERIFICATION_IMAGE_DIRECTORY) {
    const resolvedDirectory = path.resolve(directory);
    let entries;
    try {
        let timer;
        entries = await Promise.race([
            fs.readdir(resolvedDirectory, { withFileTypes: true }),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const err = new Error(`scan timed out after ${VERIFICATION_IMAGE_SCAN_TIMEOUT_MS}ms`);
                    err.code = 'VERIFICATION_IMAGE_SCAN_TIMEOUT';
                    reject(err);
                }, VERIFICATION_IMAGE_SCAN_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]).finally(() => clearTimeout(timer));
    }
    catch (err) {
        const reason = err?.code === 'ENOENT'
            ? 'directory does not exist'
            : err?.message || 'directory could not be read';
        return buildSnapshot([], [`Verification image directory ${resolvedDirectory} ${reason}.`], resolvedDirectory, false);
    }

    const candidates = [];
    const issues = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (entry.isSymbolicLink()) {
            issues.push(`Ignored symbolic link: ${entry.name}`);
            continue;
        }
        if (entry.isDirectory()) {
            issues.push(`Ignored subdirectory; keep verification images in one flat folder: ${entry.name}`);
            continue;
        }
        if (!entry.isFile()) continue;
        if (entry.name.trim() !== entry.name || /[\u0000-\u001f\u007f]/.test(entry.name)) {
            issues.push(`Ignored unsafe image filename: ${JSON.stringify(entry.name)}`);
            continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        if (!SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
            issues.push(`Ignored unsupported image file: ${entry.name}`);
            continue;
        }

        const filePath = path.resolve(resolvedDirectory, entry.name);
        if (!filePath.startsWith(`${resolvedDirectory}${path.sep}`)) {
            issues.push(`Ignored unsafe image path: ${entry.name}`);
            continue;
        }
        try {
            const stats = await fs.stat(filePath);
            if (!stats.isFile()) {
                issues.push(`Ignored non-file verification image: ${entry.name}`);
                continue;
            }
            const identity = getImageStatIdentity(stats);
            const contentSha256 = await getVerificationImageContentSha256(filePath, identity);
            candidates.push(Object.freeze({
                id: entry.name,
                filePath,
                rootDirectory: resolvedDirectory,
                ...identity,
                contentSha256,
            }));
        }
        catch (error) {
            issues.push(`Ignored unreadable verification image ${entry.name}: ${error.message}`);
        }
    }

    const activeFilePaths = new Set(candidates.map((image) => image.filePath));
    for (const cacheKey of imageContentFingerprintCache.keys()) {
        const separatorIndex = cacheKey.indexOf('\u0000');
        const cachedFilePath = separatorIndex < 0 ? cacheKey : cacheKey.slice(0, separatorIndex);
        if (!activeFilePaths.has(cachedFilePath)) imageContentFingerprintCache.delete(cacheKey);
    }

    const caseInsensitiveIds = new Map();
    for (const image of candidates) {
        const normalizedId = image.id.normalize('NFC').toLocaleLowerCase('en');
        const collisions = caseInsensitiveIds.get(normalizedId) ?? [];
        collisions.push(image);
        caseInsensitiveIds.set(normalizedId, collisions);
    }

    const images = [];
    for (const collisions of caseInsensitiveIds.values()) {
        if (collisions.length > 1) {
            issues.push(`Ignored case-insensitive filename collision: ${collisions.map((image) => image.id).join(', ')}`);
            continue;
        }
        images.push(collisions[0]);
    }
    return buildSnapshot(images, issues, resolvedDirectory, true);
}

async function refreshVerificationImageInventory({ force = false, directory = VERIFICATION_IMAGE_DIRECTORY } = {}) {
    const resolvedDirectory = path.resolve(directory);
    if (
        !force
        && inventorySnapshot.directory === resolvedDirectory
        && inventorySnapshot.scannedAt > 0
        && Date.now() - inventorySnapshot.scannedAt < VERIFICATION_IMAGE_REFRESH_TTL_MS
    ) {
        return inventorySnapshot;
    }
    if (refreshPromise) return refreshPromise;

    refreshPromise = scanVerificationImages(resolvedDirectory)
        .then((snapshot) => (inventorySnapshot = retainLastKnownGoodImages(snapshot)))
        .finally(() => {
            refreshPromise = undefined;
        });
    return refreshPromise;
}

function getVerificationImageInventory() {
    return inventorySnapshot;
}

function getVerificationImage(imageId, inventory = inventorySnapshot) {
    return inventory?.byId?.get(String(imageId));
}

function getUnknownVerificationImageIds(imageIds, inventory = inventorySnapshot) {
    return [...new Set((imageIds ?? []).map(String))]
        .filter((imageId) => !getVerificationImage(imageId, inventory));
}

async function readVerificationImageFileNow(image, { verifyContentSha256 = false } = {}) {
    const rootDirectory = path.resolve(image?.rootDirectory ?? VERIFICATION_IMAGE_DIRECTORY);
    const expectedPath = path.resolve(rootDirectory, String(image?.id ?? ''));
    if (!image?.filePath || image.filePath !== expectedPath || !expectedPath.startsWith(`${rootDirectory}${path.sep}`)) {
        throw new Error(`Invalid local verification image reference: ${image?.id ?? 'unknown'}`);
    }

    const abortController = new AbortController();
    const operation = (async () => {
        const handle = await fs.open(expectedPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        try {
            const stat = await handle.stat();
            if (!stat.isFile()) throw new Error(`Verification image is not a regular file: ${image.id}`);
            const expectedIdentity = {
                size: image.size,
                modifiedAtMs: image.modifiedAtMs,
                changedAtMs: image.changedAtMs,
                inode: image.inode,
            };
            const openedIdentity = getImageStatIdentity(stat);
            const metadataMatchesInventory = image.size === undefined
                || imageStatsMatchIdentity(stat, expectedIdentity);
            const hasContentFingerprint = hasImageContentFingerprint(image);
            if (!metadataMatchesInventory && !hasContentFingerprint) {
                throw createInventoryChangedError(
                    image,
                    'changed after the image inventory was scanned.',
                );
            }
            if (stat.size > VERIFICATION_IMAGE_MAX_FILE_BYTES) {
                throw new Error(`Verification image ${image.id} is ${stat.size} bytes; the limit is ${VERIFICATION_IMAGE_MAX_FILE_BYTES} bytes.`);
            }
            const buffer = await handle.readFile({ signal: abortController.signal });
            if (buffer.length > VERIFICATION_IMAGE_MAX_FILE_BYTES) {
                throw new Error(`Verification image ${image.id} grew beyond the ${VERIFICATION_IMAGE_MAX_FILE_BYTES}-byte limit while being read.`);
            }
            const completedStat = await handle.stat();
            const changedWhileReading = !imageStatsMatchIdentity(completedStat, openedIdentity)
                || buffer.length !== openedIdentity.size;
            if (changedWhileReading && !hasContentFingerprint) {
                throw createInventoryChangedError(image, 'changed while it was being read.');
            }
            if (
                hasContentFingerprint
                && (verifyContentSha256 || !metadataMatchesInventory || changedWhileReading)
            ) {
                const actualSha256 = crypto.createHash('sha256').update(buffer).digest('hex');
                if (actualSha256 !== image.contentSha256) {
                    throw createInventoryChangedError(
                        image,
                        'content changed after the image inventory was scanned.',
                    );
                }
            }
            return buffer;
        }
        finally {
            await handle.close();
        }
    })();
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    abortController.abort();
                    const err = new Error(`Timed out reading verification image ${image.id} after ${VERIFICATION_IMAGE_READ_TIMEOUT_MS}ms.`);
                    err.code = 'VERIFICATION_IMAGE_READ_TIMEOUT';
                    reject(err);
                }, VERIFICATION_IMAGE_READ_TIMEOUT_MS);
                timer.unref?.();
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}

function readVerificationImageFile(image, {
    priority = 'live',
    verifyContentSha256 = process.env.WARDEN_VERIFICATION_RENDER_CHILD === '1',
} = {}) {
    return runVerificationImageRead(
        () => readVerificationImageFileNow(image, { verifyContentSha256 }),
        {
            priority,
            label: `Reading verification image ${image?.id ?? 'unknown'}`,
        },
    );
}

module.exports = {
    getUnknownVerificationImageIds,
    getVerificationImage,
    getVerificationImageInventory,
    readVerificationImageFile,
    refreshVerificationImageInventory,
};
