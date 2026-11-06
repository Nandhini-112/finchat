const crypto = require('crypto');
const { ValidationError } = require('../utils/errors');

const SEARCH_KEY_PATTERN = /^[A-Za-z0-9_\-=]+$/;
const VECTOR_DIMENSIONS = 1536;

/**
 * Fields added to the existing finance-hr-documents index.
 * Existing fields (id, title, content, source, contentVector) stay unchanged.
 */
const EXTENDED_INDEX_FIELDS = [
    { name: 'chunkIndex', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'documentId', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'documentVersionId', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'documentKey', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'queueKey', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'fileName', type: 'Edm.String', searchable: true, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'fileLink', type: 'Edm.String', searchable: false, filterable: false, sortable: false, facetable: false, retrievable: true },
    { name: 'heading', type: 'Edm.String', searchable: true, filterable: false, sortable: false, facetable: false, retrievable: true },
    { name: 'pageNumber', type: 'Edm.Int32', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'department', type: 'Edm.String', searchable: true, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'jobTitle', type: 'Edm.String', searchable: true, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'authorityRank', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'authoritySource', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'modifiedDate', type: 'Edm.DateTimeOffset', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true }
];

const RETRIEVABLE_EXTENDED_FIELDS = EXTENDED_INDEX_FIELDS.map(field => field.name);

function blankToNull(value) {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text ? text : null;
}

function normalizeAuthorityRank(value) {
    if (value === undefined || value === null || value === '') return null;
    const rank = Number(value);
    if (!Number.isInteger(rank) || rank < 1) return null;
    return rank;
}

function normalizeModifiedDate(value) {
    const text = blankToNull(value);
    if (!text) return null;
    const parsed = new Date(text);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed.toISOString();
}

function normalizePageNumber(value) {
    if (value === undefined || value === null || value === '') return null;
    const page = Number(value);
    if (!Number.isInteger(page) || page < 1) return null;
    return page;
}

/**
 * Azure AI Search document keys allow letters, digits, underscore, dash, and equals.
 * Queue keys contain "|", so the readable prefix is sanitized and a hash keeps versions distinct.
 */
function buildChunkId({ queueKey, documentId, chunkIndex }) {
    const index = Number(chunkIndex);
    if (!Number.isInteger(index) || index < 0) {
        throw new ValidationError('Chunk index must be a non-negative integer.');
    }

    const versionKey = blankToNull(queueKey);
    if (versionKey) {
        const hash = crypto.createHash('sha256').update(`${versionKey}#${index}`).digest('hex').slice(0, 20);
        const readable = versionKey.replace(/[^A-Za-z0-9_\-=]/g, '_').slice(0, 80);
        return `qk_${readable}_${hash}_c${index}`;
    }

    const documentIdentity = blankToNull(documentId);
    if (!documentIdentity) {
        throw new ValidationError('A queueKey or documentId is required to build a search document id.');
    }

    const safeDocumentId = documentIdentity.replace(/[^A-Za-z0-9_\-=]/g, '_');
    return `doc_${safeDocumentId}_chunk_${index}`;
}

function resolveDocumentKey(record) {
    const fromList = blankToNull(record && record.DocumentKey);
    if (fromList) return fromList;
    const driveId = blankToNull(record && record.DriveId);
    const driveItemId = blankToNull(record && record.DriveItemId);
    if (driveId && driveItemId) return `${driveId}|${driveItemId}`;
    return null;
}

function resolveQueueKey(record) {
    const fromList = blankToNull(record && record.QueueKey);
    if (fromList) return fromList;
    const documentKey = resolveDocumentKey(record);
    const version = blankToNull(record && record.FileVersion);
    if (documentKey && version) return `${documentKey}|${version}`;
    return null;
}

function buildSearchDocument({ chunk, contentVector, metadata = {} }) {
    if (!chunk || !blankToNull(chunk.id) || !blankToNull(chunk.content)) {
        throw new ValidationError('Search chunk is missing an id or content.');
    }
    if (!SEARCH_KEY_PATTERN.test(chunk.id)) {
        throw new ValidationError('Search document id contains characters Azure AI Search rejects.');
    }
    if (!Array.isArray(contentVector) || contentVector.length !== VECTOR_DIMENSIONS) {
        throw new ValidationError(`Search document requires a ${VECTOR_DIMENSIONS}-dimension content vector.`);
    }

    const fileName = blankToNull(metadata.fileName) || blankToNull(chunk.source);
    const authorityRank = normalizeAuthorityRank(metadata.authorityRank);

    return {
        id: chunk.id,
        title: blankToNull(chunk.title) || fileName || 'Document',
        content: String(chunk.content).trim(),
        source: blankToNull(chunk.source) || fileName || '',
        contentVector,
        chunkIndex: Number.isInteger(Number(chunk.chunkIndex)) ? Number(chunk.chunkIndex) : null,
        documentId: blankToNull(metadata.documentId) || blankToNull(chunk.documentId),
        documentVersionId: blankToNull(metadata.documentVersionId),
        documentKey: blankToNull(metadata.documentKey),
        queueKey: blankToNull(metadata.queueKey),
        fileName,
        fileLink: blankToNull(metadata.fileLink),
        heading: blankToNull(chunk.heading) || blankToNull(chunk.sectionTitle),
        pageNumber: normalizePageNumber(chunk.pageNumber),
        department: blankToNull(metadata.department),
        jobTitle: blankToNull(metadata.jobTitle),
        authorityRank,
        authoritySource: authorityRank == null ? null : (blankToNull(metadata.authoritySource) || 'DocumentRank'),
        modifiedDate: normalizeModifiedDate(metadata.modifiedDate)
    };
}

function toLegacySearchDocument(document) {
    return {
        id: document.id,
        title: document.title,
        content: document.content,
        source: document.source,
        contentVector: document.contentVector
    };
}

function escapeODataString(value) {
    return String(value).replace(/'/g, "''");
}

module.exports = {
    VECTOR_DIMENSIONS,
    EXTENDED_INDEX_FIELDS,
    RETRIEVABLE_EXTENDED_FIELDS,
    blankToNull,
    buildChunkId,
    resolveDocumentKey,
    resolveQueueKey,
    buildSearchDocument,
    toLegacySearchDocument,
    escapeODataString
};
