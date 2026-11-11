const { app } = require('@azure/functions');
const { validateChatRequest } = require('../utils/validation');
const { toErrorResponse, NotFoundError } = require('../utils/errors');
const { classifyIntent } = require('../services/intent-classifier');
const { generateEmbedding } = require('../services/embeddings');
const { searchSimilar } = require('../services/azure-search');
const { getDocumentById } = require('../services/sql');
const { getFactsWithConflictContext } = require('../services/conflict-resolver');
const { evaluateDeterministicCalculations, computePeriodComparison } = require('../services/calculation-engine');
const { findRelevantStructuredFacts, formatSourceReferences } = require('../services/evidence-validation');
const { generateAnswer } = require('../services/answer-generation');
const { getActiveModelInfo } = require('../services/model-client');

app.http('chat', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const generatedCorrelationId = `chat-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        let correlationId = generatedCorrelationId;
        context.log(`[${correlationId}] >>> START CHAT REQUEST <<< URL=${request.url}`);

        let currentStep = 'INITIALIZATION';

        try {
            // STEP 0: Parse request, validate permissions, and resolve active LLM
            currentStep = 'STEP 0: REQUEST PARSING & VALIDATION';
            const body = await request.json().catch(() => null);
            const { question, documentId } = validateChatRequest(body);
            const userGroupsHeader = request.headers.get('x-user-groups') || (body && body.userGroups) || null;

            const jobId = (body && (body.jobId || body.job_id || body.correlationId)) ||
                          request.headers.get('x-job-id') ||
                          request.headers.get('x-correlation-id') ||
                          generatedCorrelationId;
            correlationId = jobId;

            // Log the chosen LLM for this current job ID
            let activeModelInfo = { model: 'unknown', provider: 'unknown' };
            try {
                activeModelInfo = getActiveModelInfo();
                context.log(`[${jobId}] [Job: ${jobId}] Chosen LLM: Provider="${activeModelInfo.provider}", Model="${activeModelInfo.model}"`);
            } catch (modelErr) {
                context.warn(`[${jobId}] [Job: ${jobId}] Could not resolve active LLM: ${modelErr.message}`);
            }

            context.log(`[${correlationId}] Step 0 Output: Question="${question}", TargetDocument=${documentId || 'ALL'}, UserGroups=${userGroupsHeader || 'Public'}`);

            let targetDoc = null;
            let searchFilter = null;

            if (documentId) {
                targetDoc = await getDocumentById(documentId);
                if (!targetDoc) {
                    throw new NotFoundError(`Document with ID or name "${documentId}" was not found.`);
                }

                // Check document-level access permissions if configured
                if (targetDoc.AllowedUserGroups && userGroupsHeader) {
                    const allowed = targetDoc.AllowedUserGroups.split(',').map(g => g.trim().toLowerCase());
                    const userGroups = userGroupsHeader.split(',').map(g => g.trim().toLowerCase());
                    const hasAccess = userGroups.some(ug => allowed.includes(ug)) || allowed.includes('*');
                    if (!hasAccess) {
                        return {
                            status: 403,
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                status: 'FORBIDDEN',
                                answer: 'Access denied: You do not have the required permissions to access this document.',
                                documentId: targetDoc.DocumentId,
                                insufficientEvidence: true,
                                correlationId
                            })
                        };
                    }
                }

                if (targetDoc.IngestionStatus === 'Processing') {
                    return {
                        status: 409,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            status: 'PROCESSING',
                            answer: `Document "${targetDoc.FileName}" is currently being processed. Please try again shortly.`,
                            documentId: targetDoc.DocumentId,
                            sources: [],
                            insufficientEvidence: true,
                            correlationId
                        })
                    };
                }

                if (targetDoc.IngestionStatus === 'Failed') {
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            status: 'FAILED',
                            answer: `Ingestion previously failed for document "${targetDoc.FileName}". Please re-ingest the document.`,
                            documentId: targetDoc.DocumentId,
                            sources: [],
                            insufficientEvidence: true,
                            correlationId
                        })
                    };
                }

                searchFilter = `source eq '${targetDoc.FileName.replace(/'/g, "''")}'`;
            }

            // STEP 1: Intent classification and routing (LLM with rule fallback)
            currentStep = 'STEP 1: INTENT CLASSIFICATION';
            context.log(`[${correlationId}] === ${currentStep} ===`);

            const intent = await classifyIntent(question, correlationId);
            context.log(`[${correlationId}] Step 1 Output (Intent Routing):`);
            context.log(`[${correlationId}]   - Selected Route: ${intent.route}`);
            context.log(`[${correlationId}]   - Intent Type: ${intent.intentType}`);
            context.log(`[${correlationId}]   - Is Comparison: ${intent.isComparison}`);
            context.log(`[${correlationId}]   - Target Periods/Dates: [${(intent.periods || []).join(', ')}]`);
            context.log(`[${correlationId}]   - Target Metrics: [${(intent.metrics || []).join(', ')}]`);
            context.log(`[${correlationId}]   - Routing Confidence: ${intent.confidence}`);
            context.log(`[${correlationId}]   - Reasoning: ${intent.reasoning}`);

            let routeUsed = intent.route;
            let finalAnswer = '';
            let formattedSources = [];
            let relevantFacts = [];
            let calculations = [];
            let insufficientEvidence = false;
            let totalInputTokens = intent?.usage?.inputTokens || 0;
            let totalOutputTokens = intent?.usage?.outputTokens || 0;

            // FLOW A: Query SQL facts, compute deterministic math, and generate answer
            if (routeUsed === 'DIRECT_SQL') {
                currentStep = 'FLOW A: DIRECT SQL RETRIEVAL & CALCULATIONS';
                context.log(`[${correlationId}] === ${currentStep} ===`);

                // 1. Fetch structured facts from database with conflict context
                const allFacts = await getFactsWithConflictContext(targetDoc ? targetDoc.DocumentId : null);
                relevantFacts = findRelevantStructuredFacts(question, allFacts);

                context.log(`[${correlationId}] Step 2A Output: Retrieved ${relevantFacts.length} relevant structured fact(s) from SQL`);

                // 2. Compute period comparisons deterministically (e.g., Q1 vs Q2)
                if (intent.isComparison && intent.periods && intent.periods.length >= 2) {
                    const periodDiffs = computePeriodComparison(allFacts, intent.periods[0], intent.periods[1]);
                    if (periodDiffs.length > 0) {
                        calculations.push(...periodDiffs);
                        context.log(`[${correlationId}]   - Computed ${periodDiffs.length} period-over-period comparison variance(s).`);
                    }
                }

                // 3. Compute deterministic arithmetic (variances, category sums, discrepancies)
                const mathCalcs = evaluateDeterministicCalculations(question, relevantFacts, intent);
                if (mathCalcs.length > 0) {
                    calculations.push(...mathCalcs);
                    context.log(`[${correlationId}]   - Evaluated ${mathCalcs.length} deterministic calculation(s).`);
                }

                // Check if any retrieved facts have document conflicts
                const conflictsPresent = relevantFacts.filter(f => f.hasConflict);
                if (conflictsPresent.length > 0) {
                    context.log(`[${correlationId}]   - Active Conflicts Found: ${conflictsPresent.length} (Passing governance notes to LLM)`);
                }

                // 4. Synthesize final answer with LLM or fallback to Azure AI Search
                if (relevantFacts.length > 0 || calculations.length > 0) {
                    currentStep = 'FLOW A: LLM SQL ANSWER SYNTHESIS';
                    context.log(`[${correlationId}] === ${currentStep} ===`);

                    const llmResult = await generateAnswer(question, [], relevantFacts, calculations, correlationId);
                    finalAnswer = llmResult.answer;
                    insufficientEvidence = llmResult.insufficientEvidence;
                    if (llmResult.usage) {
                        totalInputTokens += llmResult.usage.inputTokens || 0;
                        totalOutputTokens += llmResult.usage.outputTokens || 0;
                    }

                    // Format source file references
                    const uniqueFiles = [...new Set(relevantFacts.map(f => f.SourceFileName).filter(Boolean))];
                    formattedSources = uniqueFiles.map((file, idx) => ({
                        id: idx + 1,
                        source: file,
                        citation: `[${idx + 1}] ${file}`
                    }));

                    context.log(`[${correlationId}] Flow A Completed: Synthesized answer using LLM Model="${llmResult.model || activeModelInfo.model}" (Provider: ${llmResult.provider || activeModelInfo.provider}) (${finalAnswer.length} chars).`);
                } else {
                    context.log(`[${correlationId}] Flow A Notice: 0 SQL facts matched. Seamlessly falling back to Flow B (Azure AI Search)...`);
                    routeUsed = 'AZURE_SEARCH';
                }
            }

            // FLOW B: Search document text via Azure AI Search (semantic search)
            if (routeUsed === 'AZURE_SEARCH') {
                currentStep = 'FLOW B: AZURE AI SEARCH';
                context.log(`[${correlationId}] === ${currentStep} ===`);

                // 1. Generate query vector embedding (Azure OpenAI)
                context.log(`[${correlationId}] Step 2B: Generating query vector embedding...`);
                const queryVector = await generateEmbedding(question, correlationId);

                // 2. Perform hybrid / semantic search against index
                context.log(`[${correlationId}] Step 2B: Searching Azure AI Search index "${process.env.AZURE_SEARCH_INDEX || 'configured index'}"...`);
                const chunks = await searchSimilar(queryVector, {
                    top: 4,
                    filter: searchFilter,
                    searchText: question
                });
                context.log(`[${correlationId}] Step 2B Output: Retrieved ${chunks.length} matching search chunk(s).`);

                // 3. Format source citations
                formattedSources = formatSourceReferences(chunks);

                // 4. Synthesize final answer using active LLM
                currentStep = 'FLOW B: LLM SEARCH ANSWER SYNTHESIS';
                context.log(`[${correlationId}] === ${currentStep} ===`);

                const llmResult = await generateAnswer(question, chunks, [], [], correlationId);
                finalAnswer = llmResult.answer;
                insufficientEvidence = llmResult.insufficientEvidence;
                if (llmResult.usage) {
                    totalInputTokens += llmResult.usage.inputTokens || 0;
                    totalOutputTokens += llmResult.usage.outputTokens || 0;
                }

                context.log(`[${correlationId}] Flow B Completed: Synthesized answer using LLM Model="${llmResult.model || activeModelInfo.model}" (Provider: ${llmResult.provider || activeModelInfo.provider}) (${finalAnswer.length} chars).`);
            }

            const tokenUsage = {
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens
            };

            // STEP 3: Assemble response and log token usage
            context.log(`[${correlationId}] [Job: ${correlationId}] === TOKEN USAGE PER REQUEST ===`);
            context.log(`[${correlationId}]   - LLM Provider:               ${activeModelInfo.provider}`);
            context.log(`[${correlationId}]   - LLM Model:                  ${activeModelInfo.model}`);
            context.log(`[${correlationId}]   - Input (Prompt) Tokens:      ${tokenUsage.inputTokens}`);
            context.log(`[${correlationId}]   - Output (Completion) Tokens: ${tokenUsage.outputTokens}`);
            context.log(`[${correlationId}]   - Total Tokens:               ${tokenUsage.totalTokens}`);
            context.log(`[${correlationId}] >>> CHAT REQUEST COMPLETED SUCCESSFULLY <<< JobID=${correlationId}, Route=${routeUsed}, LLM=${activeModelInfo.model}`);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    routeUsed,
                    intentType: intent.intentType,
                    answer: finalAnswer,
                    documentId: targetDoc ? targetDoc.DocumentId : (relevantFacts[0]?.DocumentId || null),
                    sources: formattedSources,
                    factsUsed: relevantFacts.map(f => ({
                        metric: f.Metric,
                        entity: f.Entity,
                        period: f.PeriodLabel,
                        value: f.NumericValue !== null ? f.NumericValue : f.TextValue,
                        unit: f.Unit,
                        currency: f.Currency,
                        location: f.SourceLocation,
                        sourceFile: f.SourceFileName,
                        authorityRank: f.AuthorityRank,
                        authorityType: f.AuthorityType,
                        hasConflict: f.hasConflict || false,
                        conflictStatus: f.conflictStatus || null,
                        conflictExplanation: f.conflictExplanation || null
                    })),
                    calculations,
                    insufficientEvidence,
                    tokenUsage,
                    llmProvider: activeModelInfo.provider,
                    llmModel: activeModelInfo.model,
                    jobId: correlationId,
                    correlationId
                })
            };

        } catch (error) {
            context.error(`[${correlationId}] !!! CHAT FAILED AT [${currentStep}] !!!`);
            context.error(`[${correlationId}] Error: ${error.message}`);
            if (error.stack) context.error(`[${correlationId}] Stack: ${error.stack}`);
            return toErrorResponse(error, correlationId);
        }
    }
});
