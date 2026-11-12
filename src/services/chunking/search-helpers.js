const { escapeODataString } = require('../search-document');

/**
 * Builds Azure AI Search filter expression.
 * Default filter: (is_latest eq true or is_latest eq null)
 * When includeHistory is true, the is_latest clause is omitted.
 * Appends entity and period filters when provided.
 */
function buildDefaultSearchFilter(options = {}) {
    const { entity, period, includeHistory, status } = options;
    const filters = [];

    // History mode check: by default, only retrieve latest or untagged versions
    if (!includeHistory) {
        filters.push('(is_latest eq true or is_latest eq null)');
    }

    if (entity) {
        filters.push(`entity eq '${escapeODataString(entity.trim())}'`);
    }

    if (period) {
        filters.push(`period_label eq '${escapeODataString(period.trim())}'`);
    }

    if (status) {
        filters.push(`status eq '${escapeODataString(status.trim())}'`);
    }

    return filters.length > 0 ? filters.join(' and ') : null;
}

/**
 * Fetches all chunks belonging to a document_id, ordered by chunk_index ascending.
 * Allows the chat layer to read a retrieved chunk in full document context.
 */
async function expandDocumentChunks(documentId, searchClient) {
    if (!documentId || !searchClient) return [];

    const filter = `document_id eq '${escapeODataString(documentId)}'`;
    try {
        const results = await searchClient.search('*', {
            filter,
            orderBy: ['chunk_index asc'],
            top: 100
        });

        const chunks = [];
        for await (const row of results.results) {
            chunks.push(row.document);
        }
        return chunks;
    } catch (err) {
        console.warn(`[SearchHelpers] Failed to expand document chunks for ${documentId}:`, err.message);
        return [];
    }
}

/**
 * Computes stale chunk ids to delete when re-ingesting a document.
 * Returns only those IDs from previous ingestion that are no longer produced.
 */
function findStaleChunkIds(existingIds = [], currentIds = []) {
    const currentSet = new Set(currentIds);
    return existingIds.filter(id => !currentSet.has(id));
}

module.exports = {
    buildDefaultSearchFilter,
    expandDocumentChunks,
    findStaleChunkIds
};

