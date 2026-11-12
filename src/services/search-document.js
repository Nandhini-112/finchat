const crypto = require('crypto');
const { ValidationError } = require('../utils/errors');

const SEARCH_KEY_PATTERN = /^[A-Za-z0-9_\-=]+$/;
const VECTOR_DIMENSIONS = 1536;

/**
 * Fields added to the existing finance-hr-documents index.
 * Existing fields (id, title, content, source, contentVector) stay unchanged.
 */
const EXTENDED_INDEX_FIELDS = [
    // Legacy extended fields
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
    { name: 'modifiedDate', type: 'Edm.DateTimeOffset', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },

    // FinChat Chunking Pipeline New Fields
    { name: 'document_id', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'document_family_id', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'chunk_type', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'entity', type: 'Edm.String', searchable: true, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'document_type', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'period_label', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'basis', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'status', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'currency', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'language', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'section_title', type: 'Edm.String', searchable: true, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'table_id', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'supersedes', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'superseded_by', type: 'Edm.String', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'chunk_index', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'version', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'page_start', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'page_end', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'table_part', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'table_parts', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'chunk_count', type: 'Edm.Int32', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'audited', type: 'Edm.Boolean', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'is_latest', type: 'Edm.Boolean', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'period_end', type: 'Edm.DateTimeOffset', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'prepared_date', type: 'Edm.DateTimeOffset', searchable: false, filterable: true, sortable: true, facetable: false, retrievable: true },
    { name: 'access_tags', type: 'Collection(Edm.String)', searchable: false, filterable: true, sortable: false, facetable: false, retrievable: true },
    { name: 'search_text', type: 'Edm.String', searchable: true, filterable: false, sortable: false, facetable: false, retrievable: true }
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
    const meta = chunk.metadata || {};

    const docId = blankToNull(chunk.document_id) || blankToNull(meta.document_id) || blankToNull(metadata.documentId) || blankToNull(chunk.documentId);
    const chunkIdx = Number.isInteger(Number(chunk.chunk_index)) ? Number(chunk.chunk_index) :
                     (Number.isInteger(Number(chunk.chunkIndex)) ? Number(chunk.chunkIndex) : null);

    return {
        // Core fields (unchanged)
        id: chunk.id,
        title: blankToNull(chunk.title) || fileName || 'Document',
        content: String(chunk.content).trim(),
        source: blankToNull(chunk.source) || fileName || '',
        contentVector,

        // Legacy extended fields
        chunkIndex: chunkIdx,
        documentId: docId,
        documentVersionId: blankToNull(metadata.documentVersionId),
        documentKey: blankToNull(metadata.documentKey),
        queueKey: blankToNull(metadata.queueKey),
        fileName,
        fileLink: blankToNull(metadata.fileLink),
        heading: blankToNull(chunk.heading) || blankToNull(chunk.sectionTitle) || blankToNull(meta.section_title),
        pageNumber: normalizePageNumber(chunk.pageNumber) || normalizePageNumber(meta.page_start),
        department: blankToNull(metadata.department),
        jobTitle: blankToNull(metadata.jobTitle),
        authorityRank,
        authoritySource: authorityRank == null ? null : (blankToNull(metadata.authoritySource) || 'DocumentRank'),
        modifiedDate: normalizeModifiedDate(metadata.modifiedDate),

        // FinChat extended fields
        document_id: docId,
        document_family_id: blankToNull(chunk.document_family_id) || blankToNull(meta.document_family_id),
        chunk_type: blankToNull(chunk.chunk_type) || blankToNull(meta.chunk_type),
        entity: blankToNull(meta.entity),
        document_type: blankToNull(meta.document_type),
        period_label: blankToNull(meta.period_label),
        basis: blankToNull(meta.basis),
        status: blankToNull(meta.status),
        currency: blankToNull(meta.currency),
        language: blankToNull(meta.language) || blankToNull(chunk.language),
        section_title: blankToNull(meta.section_title) || blankToNull(chunk.heading) || blankToNull(chunk.sectionTitle),
        table_id: blankToNull(meta.table_id),
        supersedes: blankToNull(meta.supersedes),
        superseded_by: blankToNull(meta.superseded_by),
        chunk_index: chunkIdx,
        version: Number.isInteger(Number(meta.version)) ? Number(meta.version) : null,
        page_start: Number.isInteger(Number(meta.page_start)) ? Number(meta.page_start) : normalizePageNumber(chunk.pageNumber),
        page_end: Number.isInteger(Number(meta.page_end)) ? Number(meta.page_end) : normalizePageNumber(chunk.pageNumber),
        table_part: Number.isInteger(Number(meta.table_part)) ? Number(meta.table_part) : null,
        table_parts: Number.isInteger(Number(meta.table_parts)) ? Number(meta.table_parts) : null,
        chunk_count: Number.isInteger(Number(meta.chunk_count)) ? Number(meta.chunk_count) : null,
        audited: typeof meta.audited === 'boolean' ? meta.audited : null,
        is_latest: typeof meta.is_latest === 'boolean' ? meta.is_latest : null,
        period_end: normalizeModifiedDate(meta.period_end),
        prepared_date: normalizeModifiedDate(meta.prepared_date),
        access_tags: Array.isArray(meta.access_tags) ? meta.access_tags : (Array.isArray(chunk.access_tags) ? chunk.access_tags : []),
        search_text: blankToNull(chunk.search_text)
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
