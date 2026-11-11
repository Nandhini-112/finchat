require('../utils/config');
const { OpenAI, AzureOpenAI } = require('openai');
const { AppError } = require('../utils/errors');

let llmClient = null;
let activeModel = '';
let activeProvider = '';

/**
 * Selects which LLM client to use:
 * 1. Checks .env for Azure OpenAI (primary production model using official AzureOpenAI client).
 * 2. If Azure is not configured, falls back to Groq (using standard OpenAI client).
 * 
 * Note: If Groq is removed in the future, only this function needs updating.
 */
function getClient() {
    if (llmClient) {
        return { client: llmClient, model: activeModel, provider: activeProvider };
    }

    // Step 1: Check for Azure OpenAI configuration
    const hasAzure = Boolean(
        process.env.AZURE_OPENAI_ENDPOINT &&
        process.env.AZURE_OPENAI_API_KEY &&
        process.env.AZURE_OPENAI_CHAT_DEPLOYMENT
    );

    if (hasAzure) {
        const rawEndpoint = process.env.AZURE_OPENAI_ENDPOINT.trim().replace(/\/+$/, '');
        const cleanEndpoint = rawEndpoint.replace(/\/openai(\/v1)?$/, '');
        const apiVersion = (process.env.AZURE_OPENAI_API_VERSION || process.env.OPENAI_API_VERSION || '2024-06-01').trim();
        const deployment = process.env.AZURE_OPENAI_CHAT_DEPLOYMENT.trim();

        llmClient = new AzureOpenAI({
            endpoint: cleanEndpoint,
            apiKey: process.env.AZURE_OPENAI_API_KEY.trim(),
            apiVersion,
            deployment,
            maxRetries: 2,
            timeout: Number(process.env.AZURE_OPENAI_TIMEOUT_SECONDS || 30) * 1000
        });
        activeModel = deployment;
        activeProvider = 'azure';
        return { client: llmClient, model: activeModel, provider: activeProvider };
    }

    // Step 2: Fallback to Groq if Azure is not set
    const hasGroq = Boolean(
        process.env.GROQ_API_KEY &&
        process.env.GROQ_BASE_URL &&
        process.env.GROQ_MODEL
    );

    if (hasGroq) {
        llmClient = new OpenAI({
            apiKey: process.env.GROQ_API_KEY.trim(),
            baseURL: process.env.GROQ_BASE_URL.trim().replace(/\/+$/, ''),
            maxRetries: Number(process.env.GROQ_MAX_RETRIES || 2),
            timeout: Number(process.env.GROQ_TIMEOUT_SECONDS || 45) * 1000
        });
        activeModel = process.env.GROQ_MODEL.trim();
        activeProvider = 'groq';
        return { client: llmClient, model: activeModel, provider: activeProvider };
    }

    throw new AppError(
        'No LLM model configured in env. Please set Azure OpenAI (AZURE_OPENAI_*) or Groq (GROQ_*) in local.settings.json or .env.',
        500
    );
}

/**
 * Returns the active model name and provider ('azure' or 'groq').
 */
function getActiveModelInfo() {
    const { model, provider } = getClient();
    return { model, provider };
}

/**
 * Executes a chat completion call using the active LLM (Azure or Groq).
 * Logs the chosen model and token counts for the given job ID.
 */
async function chatCompletion({ messages, maxTokens, temperature, responseFormat, timeoutMs, jobId, correlationId }) {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
        throw new AppError('Messages array is required for chat completion.', 400);
    }

    const { client, model, provider } = getClient();
    const activeJobId = jobId || correlationId || null;
    const jobTag = activeJobId ? `[Job: ${activeJobId}] ` : '';

    console.log(`${jobTag}[LLM Selection] Chosen LLM for Job ID "${activeJobId || 'N/A'}": Model="${model}" (Provider: ${provider})`);

    const options = Number.isInteger(timeoutMs) ? { timeout: timeoutMs } : undefined;

    const payload = {
        model,
        messages,
        max_tokens: Number(maxTokens || process.env.LLM_MAX_TOKENS || process.env.GROQ_MAX_TOKENS || 4096),
        temperature: Number(temperature !== undefined ? temperature : (process.env.LLM_TEMPERATURE || process.env.GROQ_TEMPERATURE || 0.1))
    };
    if (responseFormat) {
        payload.response_format = responseFormat;
    }

    try {
        const response = await client.chat.completions.create(payload, options);

        const inputTokens = response.usage?.prompt_tokens || 0;
        const outputTokens = response.usage?.completion_tokens || 0;
        const totalTokens = response.usage?.total_tokens || (inputTokens + outputTokens);

        console.log(`${jobTag}[TokenUsage] Provider: ${provider} | Model: ${model} | Input Tokens: ${inputTokens} | Output Tokens: ${outputTokens} | Total Tokens: ${totalTokens}`);

        return {
            text: response.choices?.[0]?.message?.content || '',
            choices: response.choices,
            provider,
            model,
            jobId: activeJobId,
            usage: {
                inputTokens,
                outputTokens,
                totalTokens
            },
            raw: response
        };
    } catch (err) {
        throw new AppError(`LLM call failed (${model}): ${err.message}`, 502);
    }
}

/**
 * Resets the cached LLM client (used in unit tests).
 */
function resetModelClients() {
    llmClient = null;
    activeModel = '';
    activeProvider = '';
}

module.exports = {
    chatCompletion,
    getClient,
    getActiveModelInfo,
    resetModelClients
};
