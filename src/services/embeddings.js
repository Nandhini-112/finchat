require('../utils/config');
const { AzureOpenAI } = require('openai');
const { AppError } = require('../utils/errors');

let embeddingClient = null;

/**
 * Creates the official Azure OpenAI client for embeddings.
 * Note: Uses Azure OpenAI exclusively to preserve consistent 1536-dim vectors in AI Search.
 */
function getEmbeddingClient() {
    if (!embeddingClient) {
        const endpoint = (process.env.AZURE_EMBEDDING_ENDPOINT || '').trim();
        const apiKey = (process.env.AZURE_EMBEDDING_API_KEY || '').trim();
        const deployment = (process.env.AZURE_EMBEDDING_DEPLOYMENT || '').trim();

        if (!endpoint || !apiKey || !deployment) {
            throw new AppError(
                'Azure embedding model is not configured. Please set AZURE_EMBEDDING_ENDPOINT, AZURE_EMBEDDING_API_KEY, and AZURE_EMBEDDING_DEPLOYMENT in local.settings.json or .env.',
                500
            );
        }

        const rawEndpoint = endpoint.replace(/\/+$/, '');
        const cleanEndpoint = rawEndpoint.replace(/\/openai(\/v1)?$/, '');
        const apiVersion = (process.env.AZURE_EMBEDDING_API_VERSION || process.env.AZURE_OPENAI_API_VERSION || '2024-06-01').trim();

        embeddingClient = new AzureOpenAI({
            endpoint: cleanEndpoint,
            apiKey,
            apiVersion,
            deployment,
            maxRetries: 3,
            timeout: Number(process.env.AZURE_EMBEDDING_TIMEOUT_SECONDS || 30) * 1000
        });
    }
    return embeddingClient;
}

/**
 * Generates vector embeddings (1536-dim) for multiple texts in batches.
 */
async function generateBatchEmbeddings(texts, batchSize = 10, options = {}) {
    if (!texts || !Array.isArray(texts) || texts.length === 0) {
        return [];
    }

    const jobId = typeof options === 'string' ? options : (options?.jobId || options?.correlationId || null);
    const jobTag = jobId ? `[Job: ${jobId}] ` : '';

    const client = getEmbeddingClient();
    const model = (process.env.AZURE_EMBEDDING_DEPLOYMENT || '').trim();
    const allVectors = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize).map(t => (t || '').slice(0, 8000));
        try {
            const response = await client.embeddings.create({
                model,
                input: batch
            });

            const inputTokens = response.usage?.prompt_tokens || response.usage?.total_tokens || 0;
            if (inputTokens > 0) {
                console.log(`${jobTag}[TokenUsage] Provider: azure-embeddings | Model: ${model} | Input Tokens: ${inputTokens}`);
            }

            for (const item of response.data) {
                if (item.embedding.length !== 1536) {
                    throw new AppError(`Expected 1536 embedding dimensions, got ${item.embedding.length}`, 500);
                }
                allVectors.push(item.embedding);
            }
        } catch (err) {
            if (err instanceof AppError) throw err;
            throw new AppError(`Azure embedding generation failed: ${err.message}`, 502);
        }
    }

    return allVectors;
}

/**
 * Generates a vector embedding (1536-dim) for a single query text.
 */
async function generateEmbedding(text, options = {}) {
    if (!text || typeof text !== 'string') {
        throw new AppError('Text is required to generate embedding.', 400);
    }
    const vectors = await generateBatchEmbeddings([text], 10, options);
    if (!vectors || vectors.length === 0) {
        throw new AppError('Failed to produce vector embedding for text.', 502);
    }
    return vectors[0];
}

/**
 * Resets the cached embedding client (used in unit tests).
 */
function resetEmbeddingClient() {
    embeddingClient = null;
}

module.exports = {
    generateBatchEmbeddings,
    generateEmbedding,
    getEmbeddingClient,
    resetEmbeddingClient
};
