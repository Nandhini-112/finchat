require('../utils/config');
const { SearchClient, AzureKeyCredential } = require('@azure/search-documents');
const { AppError } = require('../utils/errors');

let searchClient = null;

function getSearchClient() {
    if (!searchClient) {
        const endpoint = process.env.AZURE_SEARCH_ENDPOINT;
        const apiKey = process.env.AZURE_SEARCH_API_KEY || process.env.AZURE_SEARCH_ADMIN_KEY;
        const indexName = process.env.AZURE_SEARCH_INDEX || 'finance-hr-documents';

        if (!endpoint || !apiKey) {
            throw new AppError('Azure AI Search endpoint or API key is missing (AZURE_SEARCH_API_KEY / AZURE_SEARCH_ADMIN_KEY).', 500);
        }

        searchClient = new SearchClient(endpoint, indexName, new AzureKeyCredential(apiKey));
    }
    return searchClient;
}

async function uploadChunks(documents) {
    if (!documents || documents.length === 0) return [];
    const client = getSearchClient();

    try {
        const result = await client.uploadDocuments(documents);
        const failed = result.results.filter(r => !r.succeeded);
        if (failed.length > 0) {
            const firstErr = failed[0].errorMessage || 'Document upload error';
            throw new AppError(`Azure AI Search upload failed for ${failed.length} documents: ${firstErr}`, 502);
        }
        return result.results;
    } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(`Azure AI Search upload error: ${err.message}`, 502);
    }
}

async function searchSimilar(queryVector, options = {}) {
    const client = getSearchClient();
    const top = options.top || 4;
    const filter = options.filter || undefined;
    const searchText = (options.searchText || options.queryText || '*').trim();

    try {
        const searchResults = await client.search(searchText, {
            vectors: [
                {
                    value: queryVector,
                    kNearestNeighborsCount: top,
                    fields: ['contentVector'] // what is contentVector
                }
            ],
            filter,
            top,
            select: ['id', 'title', 'content', 'source']//TODO: To add doc user details
        });

        const documents = [];
        for await (const result of searchResults.results) {
            documents.push({
                id: result.document.id,
                title: result.document.title,
                content: result.document.content,
                source: result.document.source,
                score: result.score
            });
        }
        return documents;
    } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError(`Azure AI Search query failed: ${err.message}`, 502);
    }
}

module.exports = {
    getSearchClient,
    uploadChunks,
    searchSimilar
};
