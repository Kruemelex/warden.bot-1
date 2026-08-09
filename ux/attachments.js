'use strict';

const path = require('node:path');

function getAttachmentFileName(file) {
    if (typeof file === 'string') return path.basename(file);
    return file?.name ?? file?.attachment?.name ?? file?.data?.name;
}

function getAttachmentReferences(value, references = new Set()) {
    if (typeof value === 'string' && value.startsWith('attachment://')) {
        references.add(value.slice('attachment://'.length).split(/[?#]/, 1)[0]);
    }
    else if (Array.isArray(value)) {
        for (const child of value) getAttachmentReferences(child, references);
    }
    else if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
        for (const child of Object.values(value)) getAttachmentReferences(child, references);
    }
    return references;
}

function assertReferencedAttachments(files, references) {
    const names = files.map(getAttachmentFileName);
    for (const reference of references) {
        if (!names.includes(reference)) {
            throw new Error(`UX document references missing attachment "${reference}".`);
        }
    }
    return names;
}

function assertAttachmentExposure(files, references) {
    const names = files.map(getAttachmentFileName);
    if (names.some((name) => !name)) throw new Error('Every uploaded UX file requires a name.');
    for (const name of names) {
        if (!references.has(name)) {
            throw new Error(`Uploaded UX file "${name}" is not exposed by an attachment:// reference.`);
        }
    }
    assertReferencedAttachments(files, references);
    return names;
}

module.exports = {
    assertAttachmentExposure,
    assertReferencedAttachments,
    getAttachmentFileName,
    getAttachmentReferences,
};
