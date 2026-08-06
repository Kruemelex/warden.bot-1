const fs = require('fs/promises');
const { constants: fsConstants } = require('fs');
const path = require('path');
const { createVerificationLogger } = require('../logging');

const assetStockLog = createVerificationLogger('Asset stock');

const STOCK_MANIFEST_VERSION = 1;
const STOCK_MANIFEST_FILE = 'entry.json';
const STOCK_ENTRIES_DIRECTORY = 'entries';
const STOCK_STAGING_DIRECTORY = '.staging';
const STOCK_MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const STOCK_MAX_DELIVERIES_PER_ENTRY = 25;

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    throw signal.reason ?? Object.assign(
        new Error('Verification asset stock persistence was cancelled.'),
        { name: 'AbortError', code: 'VERIFICATION_ASSET_STOCK_ABORTED' },
    );
}

function isSafeEntryId(value) {
    return typeof value === 'string' && /^[a-f0-9-]{16,64}$/i.test(value);
}

function isSafeAssetFileName(value) {
    return typeof value === 'string'
        && /^[0-9]+-[0-9]+\.asset$/.test(value)
        && path.basename(value) === value;
}

function assertBufferFreeMetadata(value, seen = new Set()) {
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
        throw new Error('Verification asset stock metadata retained binary image data.');
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) assertBufferFreeMetadata(item, seen);
        return;
    }
    for (const item of Object.values(value)) assertBufferFreeMetadata(item, seen);
}

function normalizeManifest(manifest, entryDirectory, maxBytes) {
    if (!manifest || manifest.version !== STOCK_MANIFEST_VERSION) {
        throw new Error('Unsupported verification asset stock manifest version.');
    }
    if (!isSafeEntryId(manifest.id) || path.basename(entryDirectory) !== manifest.id) {
        throw new Error('Verification asset stock manifest has an invalid entry ID.');
    }
    if (typeof manifest.signature !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.signature)) {
        throw new Error('Verification asset stock manifest has an invalid signature.');
    }
    if (!Array.isArray(manifest.assets) || !Array.isArray(manifest.files)) {
        throw new Error('Verification asset stock manifest is incomplete.');
    }
    if (manifest.files.length < 1 || manifest.files.length > STOCK_MAX_DELIVERIES_PER_ENTRY) {
        throw new Error('Verification asset stock manifest has an invalid delivery count.');
    }
    assertBufferFreeMetadata(manifest.assets);

    let totalBytes = 0;
    const files = manifest.files.map((record) => {
        if (!Number.isInteger(record.questionIndex) || record.questionIndex < 0
            || !Number.isInteger(record.fileIndex) || record.fileIndex < 0
            || typeof record.name !== 'string' || record.name.length < 1 || record.name.length > 255
            || !isSafeAssetFileName(record.file)
            || !Number.isInteger(record.size) || record.size < 1) {
            throw new Error('Verification asset stock manifest contains an invalid delivery.');
        }
        totalBytes += record.size;
        if (totalBytes > maxBytes) {
            throw new Error('Verification asset stock entry exceeds the configured byte limit.');
        }
        return {
            questionIndex: record.questionIndex,
            fileIndex: record.fileIndex,
            name: record.name,
            path: path.join(entryDirectory, record.file),
            size: record.size,
        };
    });
    if (totalBytes !== manifest.totalBytes) {
        throw new Error('Verification asset stock manifest byte accounting is inconsistent.');
    }

    return {
        id: manifest.id,
        signature: manifest.signature,
        assets: manifest.assets,
        files,
        totalBytes,
        directory: entryDirectory,
        createdAt: Number.isFinite(manifest.createdAt) ? manifest.createdAt : 0,
        stockLifecycle: 'stocked',
    };
}

function buildManifest(entry, files) {
    assertBufferFreeMetadata(entry.assets);
    return {
        version: STOCK_MANIFEST_VERSION,
        id: entry.id,
        signature: entry.signature,
        assets: entry.assets,
        files,
        totalBytes: entry.totalBytes,
        createdAt: entry.createdAt,
    };
}

function createVerificationAssetStockStore({ rootDirectory, maxBytes, logger = assetStockLog }) {
    if (!path.isAbsolute(rootDirectory)) {
        throw new Error('Verification asset stock directory must be absolute.');
    }
    if (rootDirectory === path.parse(rootDirectory).root) {
        throw new Error('Verification asset stock directory cannot be a filesystem root.');
    }
    if (!Number.isInteger(maxBytes) || maxBytes < 1) {
        throw new Error('Verification asset stock byte limit must be a positive integer.');
    }

    const entriesDirectory = path.join(rootDirectory, STOCK_ENTRIES_DIRECTORY);
    const stagingDirectory = path.join(rootDirectory, STOCK_STAGING_DIRECTORY);
    let initializationPromise;

    async function removeDirectory(directory) {
        await fs.rm(directory, { recursive: true, force: true });
    }

    async function verifyRecoveredFiles(entry) {
        for (const record of entry.files) {
            const stats = await fs.lstat(record.path);
            if (!stats.isFile() || stats.isSymbolicLink() || stats.size !== record.size) {
                throw new Error('Verification asset stock file no longer matches its manifest.');
            }
        }
        return entry;
    }

    async function readManifestDirectory(directoryEntry) {
        const entryDirectory = path.join(entriesDirectory, directoryEntry.name);
        if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink()) {
            await removeDirectory(entryDirectory);
            return undefined;
        }
        try {
            const manifestPath = path.join(entryDirectory, STOCK_MANIFEST_FILE);
            const stats = await fs.lstat(manifestPath);
            if (!stats.isFile() || stats.isSymbolicLink() || stats.size > STOCK_MANIFEST_MAX_BYTES) {
                throw new Error('Verification asset stock manifest is not a safe regular file.');
            }
            const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
            return await verifyRecoveredFiles(normalizeManifest(manifest, entryDirectory, maxBytes));
        }
        catch (error) {
            logger.warn(
                `Removing invalid persisted entry ${directoryEntry.name}.`,
                error,
            );
            await removeDirectory(entryDirectory);
            return undefined;
        }
    }

    async function initialize() {
        if (initializationPromise) return initializationPromise;
        const attempt = (async () => {
            await fs.mkdir(entriesDirectory, { recursive: true, mode: 0o700 });
            await removeDirectory(stagingDirectory);
            await fs.mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
            const directoryEntries = await fs.readdir(entriesDirectory, { withFileTypes: true });
            const recovered = (await Promise.all(directoryEntries.map(readManifestDirectory)))
                .filter(Boolean)
                .sort((left, right) => right.createdAt - left.createdAt);
            const accepted = [];
            let acceptedBytes = 0;
            for (const entry of recovered) {
                if (acceptedBytes + entry.totalBytes <= maxBytes) {
                    accepted.push(entry);
                    acceptedBytes += entry.totalBytes;
                }
                else {
                    await removeDirectory(entry.directory);
                }
            }
            return accepted;
        })();
        initializationPromise = attempt;
        try {
            return await attempt;
        }
        catch (error) {
            if (initializationPromise === attempt) initializationPromise = undefined;
            throw error;
        }
    }

    async function persist(entry, signal) {
        await initialize();
        throwIfAborted(signal);
        if (!isSafeEntryId(entry?.id)) throw new Error('Invalid verification asset stock entry ID.');
        if (!Array.isArray(entry.deliveries) || entry.deliveries.length < 1) {
            throw new Error('Verification asset stock entry has no deliveries to persist.');
        }
        const stagePath = path.join(stagingDirectory, entry.id);
        const finalPath = path.join(entriesDirectory, entry.id);
        await fs.mkdir(stagePath, { recursive: false, mode: 0o700 });
        let committed = false;
        try {
            const files = [];
            for (const record of entry.deliveries) {
                throwIfAborted(signal);
                if (!Buffer.isBuffer(record.buffer)) {
                    throw new Error('Verification asset stock delivery was not an encoded buffer.');
                }
                const file = `${record.questionIndex}-${record.fileIndex}.asset`;
                const filePath = path.join(stagePath, file);
                await fs.writeFile(filePath, record.buffer, {
                    flag: 'wx',
                    mode: 0o600,
                    signal,
                });
                files.push({
                    questionIndex: record.questionIndex,
                    fileIndex: record.fileIndex,
                    name: record.name,
                    file,
                    size: record.buffer.length,
                });
            }
            const manifest = buildManifest(entry, files);
            const serialized = JSON.stringify(manifest);
            if (Buffer.byteLength(serialized) > STOCK_MANIFEST_MAX_BYTES) {
                throw new Error('Verification asset stock manifest exceeds its safety limit.');
            }
            throwIfAborted(signal);
            await fs.writeFile(
                path.join(stagePath, STOCK_MANIFEST_FILE),
                serialized,
                { flag: 'wx', mode: 0o600, signal },
            );
            throwIfAborted(signal);
            await fs.rename(stagePath, finalPath);
            committed = true;
            const persisted = normalizeManifest(manifest, finalPath, maxBytes);
            throwIfAborted(signal);
            Object.assign(entry, persisted);
            entry.deliveries = undefined;
            return entry;
        }
        catch (error) {
            await removeDirectory(committed ? finalPath : stagePath);
            throw error;
        }
    }

    async function readDeliveries(entry) {
        const deliveries = [];
        let totalBytes = 0;
        for (const record of entry.files ?? []) {
            const handle = await fs.open(record.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
            let buffer;
            try {
                const stats = await handle.stat();
                if (!stats.isFile() || stats.size !== record.size) {
                    throw new Error('Verification asset stock file changed before checkout.');
                }
                buffer = await handle.readFile();
            }
            finally {
                await handle.close();
            }
            totalBytes += buffer.length;
            if (totalBytes > maxBytes) {
                throw new Error('Verification asset stock checkout exceeded its byte limit.');
            }
            deliveries.push({ ...record, buffer });
        }
        if (totalBytes !== entry.totalBytes) {
            throw new Error('Verification asset stock checkout byte accounting changed.');
        }
        return deliveries;
    }

    return Object.freeze({
        entriesDirectory,
        initialize,
        persist,
        readDeliveries,
        remove: (entry) => entry?.directory ? removeDirectory(entry.directory) : Promise.resolve(),
        rootDirectory,
    });
}

module.exports = {
    createVerificationAssetStockStore,
};
