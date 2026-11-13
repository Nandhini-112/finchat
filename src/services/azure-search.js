
require('../utils/config');
const { SearchClient, AzureKeyCredential } = require('@azure/search-documents');
const { AppError } = require('../utils/errors');
const { ensureSearchIndexFields } = require('./search-index');
const {
    RETRIEVABLE_EXTENDED_FIELDS,
    escapeODataString
} = require('./search-document');

let searchClient = null;

const SELECT_FIELDS = ['id', 'title', 'content', 'source', ...RETRIEVABLE_EXTENDED_FIELDS];

function getSearchClient() {
    if (!searchClient) {
        const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
        const apiKey = process.env.AZURE_SEARCH_API_KEY || process.env.AZURE_SEARCH_ADMIN_KEY;
        const indexName = process.env.AZURE_SEARCH_INDEX || 'finance-hr-documents';

        if (!endpoint || !apiKey) {
            throw new AppError(
                'Azure AI Search endpoint or API key is missing (AZURE_SEARCH_API_KEY / AZURE_SEARCH_ADMIN_KEY).',
                500
            );
        }

        searchClient = new SearchClient(
            endpoint,
            indexName,
            new AzureKeyCredential(apiKey)
        );
    }

    return searchClient;
}

async function uploadChunks(documents) {
    if (!documents || documents.length === 0) return [];

    await ensureSearchIndexFields();
    return uploadDocuments(documents);
}

async function uploadDocuments(documents) {
    const client = getSearchClient();

    try {
        const result = await client.uploadDocuments(documents);
        const failed = result.results.filter(r => !r.succeeded);

        if (failed.length > 0) {
            const firstErr = failed[0].errorMessage || 'Document upload error';

            throw new AppError(
                `Azure AI Search upload failed for ${failed.length} documents: ${firstErr}`,
                502
            );
        }

        return result.results;
    } catch (err) {
        if (err instanceof AppError) throw err;

        throw new AppError(
            `Azure AI Search upload error: ${err.message}`,
            502
        );
    }
}

/**
 * Deletes indexed chunks for this document that are not part of the upload
 * just completed.
 *
 * A new version has different chunk ids, so uploading it does not remove
 * the previous version.
 *
 * Chunks indexed before documentKey existed have no key to match and
 * are left in place.
 */
async function deleteReplacedChunks(documentKey, retainedIds) {
    if (!documentKey) return 0;

    const client = getSearchClient();
    const retained = new Set(retainedIds || []);
    const filter = `documentKey eq '${escapeODataString(documentKey)}'`;

    const staleIds = [];
    let skip = 0;

    try {
        for (; ;) {
            const page = await client.search('*', {
                filter,
                select: ['id'],
                top: 1000,
                skip
            });

            let count = 0;

            for await (const row of page.results) {
                const id = row.document && row.document.id;

                if (id && !retained.has(id)) {
                    staleIds.push(id);
                }

                count++;
            }

            if (count < 1000) break;

            skip += count;
        }

        for (let offset = 0; offset < staleIds.length; offset += 1000) {
            const batch = staleIds
                .slice(offset, offset + 1000)
                .map(id => ({ id }));

            const result = await client.deleteDocuments(batch);
            const failed = result.results.filter(item => !item.succeeded);

            if (failed.length > 0) {
                const firstErr = failed[0].errorMessage || 'Delete error';

                throw new AppError(
                    `Failed to delete ${failed.length} replaced search chunks: ${firstErr}`,
                    502
                );
            }
        }

        return staleIds.length;
    } catch (err) {
        if (err instanceof AppError) throw err;

        throw new AppError(
            `Failed to delete replaced search chunks: ${err.message}`,
            502
        );
    }
}

/**
 * Performs hybrid keyword + vector search.
 *
 * Existing behavior is preserved by default.
 *
 * Optional:
 *   options.minScore - filters results below the supplied Azure search score.
 *   options.debug    - logs retrieved document names and scores.
 */
async function searchSimilar(queryVector, options = {}) {
    const client = getSearchClient();

    const top = options.top || 4;
    const filter = options.filter || undefined;

    const searchText = (
        options.searchText ||
        options.queryText ||
        '*'
    ).trim();

    const minScore = Number.isFinite(options.minScore)
        ? options.minScore
        : null;

    try {
        const searchResults = await client.search(searchText, {
            vectors: [
                {
                    value: queryVector,
                    kNearestNeighborsCount: top,
                    fields: ['contentVector']
                }
            ],
            filter,
            top,
            select: SELECT_FIELDS
        });

        const documents = [];

        for await (const result of searchResults.results) {
            const score = result.score;

            // Optional score filtering.
            // No filtering is applied unless minScore is explicitly supplied.
            if (
                minScore !== null &&
                typeof score === 'number' &&
                score < minScore
            ) {
                continue;
            }

            const document = {
                ...result.document,
                score
            };

            documents.push(document);

            if (options.debug === true) {
                console.log('[Azure Search] Retrieved document:', {
                    id: document.id,
                    title: document.title,
                    source: document.source,
                    score
                });
            }
        }

        if (options.debug === true) {
            console.log('[Azure Search] Search summary:', {
                query: searchText,
                top,
                minScore,
                filter,
                retrievedCount: documents.length
            });
        }

        return documents;

    } catch (err) {
        if (err instanceof AppError) throw err;

        throw new AppError(
            `Azure AI Search query failed: ${err.message}`,
            502
        );
    }
}

module.exports = {
    getSearchClient,
    uploadChunks,
    deleteReplacedChunks,
    searchSimilar
};
