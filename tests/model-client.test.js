const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const {
    getClient,
    getActiveModelInfo,
    resetModelClients,
    chatCompletion
} = require('../src/services/model-client');
const {
    generateBatchEmbeddings,
    resetEmbeddingClient
} = require('../src/services/embeddings');

describe('Unified LLM Client (Azure Priority, Groq Fallback)', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
        resetModelClients();
        resetEmbeddingClient();
    });

    test('getClient() selects Azure when Azure is configured in env', () => {
        process.env.AZURE_OPENAI_ENDPOINT = 'https://my-resource.services.ai.azure.com';
        process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
        process.env.AZURE_OPENAI_CHAT_DEPLOYMENT = 'gpt-4o';
        process.env.GROQ_API_KEY = 'test-groq-key';
        process.env.GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
        process.env.GROQ_MODEL = 'qwen/qwen3.8-27b';

        const target = getClient();
        assert.ok(target);
        assert.equal(target.provider, 'azure');
        assert.equal(target.model, 'gpt-4o');
        assert.ok(target.client);
    });

    test('getClient() seamlessly takes Groq when Azure is not in env', () => {
        delete process.env.AZURE_OPENAI_ENDPOINT;
        delete process.env.AZURE_OPENAI_API_KEY;
        delete process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
        process.env.GROQ_API_KEY = 'test-groq-key';
        process.env.GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
        process.env.GROQ_MODEL = 'qwen/qwen3.8-27b';

        const target = getClient();
        assert.ok(target);
        assert.equal(target.provider, 'groq');
        assert.equal(target.model, 'qwen/qwen3.8-27b');
        assert.ok(target.client);
    });

    test('getClient() throws error when neither Azure nor Groq is configured in env', () => {
        delete process.env.AZURE_OPENAI_ENDPOINT;
        delete process.env.AZURE_OPENAI_API_KEY;
        delete process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
        delete process.env.GROQ_API_KEY;
        delete process.env.GROQ_BASE_URL;
        delete process.env.GROQ_MODEL;

        assert.throws(
            () => getClient(),
            {
                name: 'AppError',
                message: /No LLM model configured in env/
            }
        );
    });

    test('chatCompletion rejects empty or invalid messages', async () => {
        await assert.rejects(
            async () => {
                await chatCompletion({ messages: [] });
            },
            {
                name: 'AppError',
                message: 'Messages array is required for chat completion.'
            }
        );
    });

    test('chatCompletion extracts and returns token usage', async () => {
        delete process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
        process.env.GROQ_API_KEY = 'test-key';
        process.env.GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
        process.env.GROQ_MODEL = 'qwen/qwen3.8-27b';

        const target = getClient();
        target.client.chat = {
            completions: {
                create: async () => ({
                    choices: [{ message: { content: 'Test response' } }],
                    usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 }
                })
            }
        };

        const res = await chatCompletion({ messages: [{ role: 'user', content: 'hello' }] });
        assert.equal(res.text, 'Test response');
        assert.equal(res.usage.inputTokens, 15);
        assert.equal(res.usage.outputTokens, 5);
        assert.equal(res.usage.totalTokens, 20);
    });

    test('getActiveModelInfo() returns currently active model and provider', () => {
        delete process.env.AZURE_OPENAI_ENDPOINT;
        delete process.env.AZURE_OPENAI_API_KEY;
        delete process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
        process.env.GROQ_API_KEY = 'test-groq-key';
        process.env.GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
        process.env.GROQ_MODEL = 'qwen/qwen3.8-27b';

        const info = getActiveModelInfo();
        assert.equal(info.provider, 'groq');
        assert.equal(info.model, 'qwen/qwen3.8-27b');
    });

    test('chatCompletion logs and propagates jobId when provided', async () => {
        delete process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
        process.env.GROQ_API_KEY = 'test-key';
        process.env.GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
        process.env.GROQ_MODEL = 'qwen/qwen3.8-27b';

        const target = getClient();
        target.client.chat = {
            completions: {
                create: async () => ({
                    choices: [{ message: { content: 'Job answer' } }],
                    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
                })
            }
        };

        const res = await chatCompletion({
            messages: [{ role: 'user', content: 'test question' }],
            jobId: 'chat-test-12345'
        });
        assert.equal(res.jobId, 'chat-test-12345');
        assert.equal(res.model, 'qwen/qwen3.8-27b');
        assert.equal(res.provider, 'groq');
    });
});

describe('Single Embedding Model', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        process.env = { ...originalEnv };
        resetEmbeddingClient();
    });

    test('generateBatchEmbeddings throws when Azure embedding configuration is missing from env', async () => {
        delete process.env.AZURE_EMBEDDING_ENDPOINT;
        delete process.env.AZURE_OPENAI_ENDPOINT;
        delete process.env.AZURE_EMBEDDING_API_KEY;
        delete process.env.AZURE_OPENAI_API_KEY;
        delete process.env.AZURE_EMBEDDING_DEPLOYMENT;
        delete process.env.AZURE_OPENAI_EMBEDDING_DEPLOYMENT;

        await assert.rejects(
            async () => {
                await generateBatchEmbeddings(['test text']);
            },
            {
                name: 'AppError',
                message: /Azure embedding model is not configured/
            }
        );
    });
});
