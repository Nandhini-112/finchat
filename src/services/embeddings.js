require('../utils/config');
const OpenAI = require('openai').default;
const { AppError } = require('../utils/errors');

let client = null;

function getEmbeddingClient() {
    if (!client) {
        const endpoint = process.env.AZURE_OPENAI_ENDPOINT || process.env.AZURE_EMBEDDING_ENDPOINT;
        const apiKey = process.env.AZURE_OPENAI_API_KEY || process.env.AZURE_EMBEDDING_API_KEY;

        if (!endpoint || !apiKey) {
            throw new AppError('Azure OpenAI endpoint or API key is missing (AZURE_OPENAI_ENDPOINT / AZURE_EMBEDDING_ENDPOINT).', 500);
        }

        const cleanEndpoint = endpoint.replace(/\/+$/, '');
        const baseURL = cleanEndpoint.endsWith('/openai/v1') ? `${cleanEndpoint}/` : `${cleanEndpoint}/openai/v1/`;

        client = new OpenAI({
            baseURL,
            apiKey,
            maxRetries: 3,
            timeout: 30000
        });
    }
    return client;
}

async function generateBatchEmbeddings(texts, batchSize = 10) {
    const c = getEmbeddingClient();
    const model = process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT || process.env.AZURE_EMBEDDING_DEPLOYMENT || 'text-embedding-3-small';
    const allVectors = [];

    for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize).map(t => (t || '').slice(0, 8000));
        try {

            //TODO: To make this create embedding as a fn and use it for both ingestion and chat
            const response = await c.embeddings.create({
                model,
                input: batch
            });

            for (const item of response.data) {
                if (item.embedding.length !== 1536) {
                    throw new AppError(`Expected 1536 embedding dimensions, got ${item.embedding.length}`, 500);
                }
                allVectors.push(item.embedding);
            }
        } catch (err) {
            if (err instanceof AppError) throw err;
            throw new AppError(`Batch embedding generation failed: ${err.message}`, 502);
        }
    }

    return allVectors;
}

async function generateEmbedding(text) {
    if (!text || typeof text !== 'string') {
        throw new AppError('Text is required to generate embedding.', 400);
    }
    const vectors = await generateBatchEmbeddings([text]);
    return vectors[0];
}

module.exports = {
    generateBatchEmbeddings,
    generateEmbedding
};
