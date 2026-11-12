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

app.http('chat', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const reqStartTime = Date.now();
        const correlationId = `chat-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        context.log(`[${correlationId}] [CHAT_STATUS: RECEIVED] >>> START CHAT REQUEST <<< URL=${request.url}`);

        let currentStep = 'INITIALIZATION';
        let stepStartTime = Date.now();

        try {
            // =========================================================================
            // STEP 0: REQUEST PARSING & DOCUMENT AUTHORIZATION
            // =========================================================================
            currentStep = 'STEP 0: REQUEST PARSING & VALIDATION';
            stepStartTime = Date.now();
            context.log(`[${correlationId}] [CHAT_STATUS: VALIDATING_INPUT] Parsing body and extracting authorization headers...`);

            const body = await request.json().catch(() => null);
            const { question, documentId } = validateChatRequest(body);
            const userGroupsHeader = request.headers.get('x-user-groups') || (body && body.userGroups) || null;

            context.log(`[${correlationId}] [CHAT_STATUS: INPUT_VALIDATED] Question="${question}", TargetDocument=${documentId || 'ALL'}, UserGroups=${userGroupsHeader || 'Public'} (${Date.now() - stepStartTime}ms)`);

            let targetDoc = null;
            let searchFilter = null;

            if (documentId) {
                stepStartTime = Date.now();
                context.log(`[${correlationId}] [CHAT_STATUS: DOC_LOOKUP] Querying dbo.Documents for identifier="${documentId}"...`);
                targetDoc = await getDocumentById(documentId);

                if (!targetDoc) {
                    context.error(`[${correlationId}] [CHAT_STATUS: DOC_NOT_FOUND] Document with ID or name "${documentId}" was not found.`);
                    throw new NotFoundError(`Document with ID or name "${documentId}" was not found.`);
                }

                context.log(`[${correlationId}] [CHAT_STATUS: DOC_RESOLVED] Found DocumentId=${targetDoc.DocumentId}, FileName="${targetDoc.FileName}", Status="${targetDoc.IngestionStatus}", AuthorityRank=${targetDoc.AuthorityRank} (${Date.now() - stepStartTime}ms)`);

                // Check document-level access permissions if configured
                if (targetDoc.AllowedUserGroups && userGroupsHeader) {
                    const allowed = targetDoc.AllowedUserGroups.split(',').map(g => g.trim().toLowerCase());
                    const userGroups = userGroupsHeader.split(',').map(g => g.trim().toLowerCase());
                    const hasAccess = userGroups.some(ug => allowed.includes(ug)) || allowed.includes('*');
                    if (!hasAccess) {
                        context.warn(`[${correlationId}] [CHAT_STATUS: AUTH_DENIED] Access denied: UserGroups="${userGroupsHeader}" not in AllowedUserGroups="${targetDoc.AllowedUserGroups}".`);
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
                    context.log(`[${correlationId}] [CHAT_STATUS: AUTH_GRANTED] Access granted for DocumentId=${targetDoc.DocumentId}.`);
                }

                if (targetDoc.IngestionStatus === 'Processing') {
                    context.warn(`[${correlationId}] [CHAT_STATUS: BLOCKED_PROCESSING] Document "${targetDoc.FileName}" (ID: ${targetDoc.DocumentId}) is currently being ingested (Status='Processing'). Returning 409.`);
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
                    context.warn(`[${correlationId}] [CHAT_STATUS: BLOCKED_FAILED] Ingestion previously failed for document "${targetDoc.FileName}" (ID: ${targetDoc.DocumentId}). Returning 200 with notice.`);
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

            // =========================================================================
            // STEP 1: MULTI-MODEL INTENT CLASSIFICATION & ROUTING
            // =========================================================================
            currentStep = 'STEP 1: INTENT CLASSIFICATION';
            stepStartTime = Date.now();
            context.log(`[${correlationId}] === ${currentStep} ===`);
            context.log(`[${correlationId}] [CHAT_STATUS: INTENT_CLASSIFYING] Classifying question intent and routing...`);

            const intent = await classifyIntent(question);
            context.log(`[${correlationId}] [CHAT_STATUS: INTENT_RESOLVED] Intent classified in ${Date.now() - stepStartTime}ms:`);
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

            // =========================================================================
            // FLOW A: DIRECT SQL (FINANCIAL FACTS & COMPARISONS)
            // =========================================================================
            if (routeUsed === 'DIRECT_SQL') {
                currentStep = 'FLOW A: DIRECT SQL RETRIEVAL & CALCULATIONS';
                stepStartTime = Date.now();
                context.log(`[${correlationId}] === ${currentStep} ===`);
                context.log(`[${correlationId}] [CHAT_STATUS: SQL_RETRIEVAL_START] Querying structured facts with conflict context from dbo.FinancialFacts...`);

                // 1. Fetch structured facts with governance/conflict status
                const allFacts = await getFactsWithConflictContext(targetDoc ? targetDoc.DocumentId : null);
                context.log(`[${correlationId}] [CHAT_STATUS: SQL_FACTS_FETCHED] Retrieved ${allFacts.length} total candidate fact(s) from SQL in ${Date.now() - stepStartTime}ms.`);

                stepStartTime = Date.now();
                relevantFacts = findRelevantStructuredFacts(question, allFacts);
                context.log(`[${correlationId}] [CHAT_STATUS: SQL_FACTS_MATCHED] Matched ${relevantFacts.length} relevant structured fact(s) in ${Date.now() - stepStartTime}ms.`);

                if (relevantFacts.length > 0) {
                    const sampleCount = Math.min(relevantFacts.length, 3);
                    for (let i = 0; i < sampleCount; i++) {
                        const f = relevantFacts[i];
                        context.log(`  [Fact ${i + 1}] Metric="${f.Metric}", Canon="${f.CanonicalMetric || 'N/A'}", Period="${f.PeriodLabel}", Value=${f.NumericValue ?? f.TextValue} ${f.Currency || f.Unit || ''}, Source="${f.SourceFileName}"`);
                    }
                }

                // 2. If comparison between dates/periods requested, compute period variance deterministically
                if (intent.isComparison && intent.periods && intent.periods.length >= 2) {
                    stepStartTime = Date.now();
                    const periodDiffs = computePeriodComparison(allFacts, intent.periods[0], intent.periods[1]);
                    if (periodDiffs.length > 0) {
                        calculations.push(...periodDiffs);
                        context.log(`[${correlationId}] [CHAT_STATUS: CALC_PERIOD_COMPARISON] Computed ${periodDiffs.length} period comparison variance(s) [${intent.periods[0]} vs ${intent.periods[1]}] in ${Date.now() - stepStartTime}ms.`);
                    }
                }

                // 3. Evaluate additional deterministic arithmetic (variances, category sums, discrepancies)
                stepStartTime = Date.now();
                const mathCalcs = evaluateDeterministicCalculations(question, relevantFacts, intent);
                if (mathCalcs.length > 0) {
                    calculations.push(...mathCalcs);
                    context.log(`[${correlationId}] [CHAT_STATUS: CALC_ARITHMETIC] Evaluated ${mathCalcs.length} deterministic calculation(s) in ${Date.now() - stepStartTime}ms.`);
                }

                // Check for conflict status
                const conflictsPresent = relevantFacts.filter(f => f.hasConflict);
                if (conflictsPresent.length > 0) {
                    context.log(`[${correlationId}] [CHAT_STATUS: CONFLICTS_FLAGGED] Active Conflicts Found: ${conflictsPresent.length} (Passing governance notes to LLM).`);
                }

                // 4. Synthesize Answer or Auto-Fallback
                if (relevantFacts.length > 0 || calculations.length > 0) {
                    currentStep = 'FLOW A: LLM SQL ANSWER SYNTHESIS';
                    stepStartTime = Date.now();
                    context.log(`[${correlationId}] === ${currentStep} ===`);
                    context.log(`[${correlationId}] [CHAT_STATUS: SYNTHESIS_START] Flow A: Synthesizing grounded answer with ${relevantFacts.length} fact(s) and ${calculations.length} calculation(s)...`);

                    const llmResult = await generateAnswer(question, [], relevantFacts, calculations);
                    finalAnswer = llmResult.answer;
                    insufficientEvidence = llmResult.insufficientEvidence;

                    // Build source references from SQL facts
                    const uniqueFiles = [...new Set(relevantFacts.map(f => f.SourceFileName).filter(Boolean))];
                    formattedSources = uniqueFiles.map((file, idx) => ({
                        id: idx + 1,
                        source: file,
                        citation: `[${idx + 1}] ${file}`
                    }));

                    context.log(`[${correlationId}] [CHAT_STATUS: SYNTHESIS_COMPLETE] Flow A Completed: Synthesized answer (${finalAnswer.length} chars, InsufficientEvidence=${insufficientEvidence}) in ${Date.now() - stepStartTime}ms.`);
                } else {
                    context.log(`[${correlationId}] [CHAT_STATUS: SQL_FALLBACK] Flow A Notice: 0 SQL facts matched. Seamlessly falling back to Flow B (Azure AI Search)...`);
                    routeUsed = 'AZURE_SEARCH';
                }
            }

            // =========================================================================
            // FLOW B: AZURE AI SEARCH (SEMANTIC & NARRATIVE)
            // =========================================================================
            if (routeUsed === 'AZURE_SEARCH') {
                currentStep = 'FLOW B: AZURE AI SEARCH';
                stepStartTime = Date.now();
                context.log(`[${correlationId}] === ${currentStep} ===`);

                // 1. Generate vector embedding
                context.log(`[${correlationId}] [CHAT_STATUS: EMBEDDING_START] Step 2B: Generating query vector embedding via text-embedding-3-small...`);
                const queryVector = await generateEmbedding(question);
                context.log(`[${correlationId}] [CHAT_STATUS: EMBEDDING_COMPLETE] Step 2B: Generated ${queryVector.length}-dim vector embedding in ${Date.now() - stepStartTime}ms.`);

                // 2. Search Azure AI Search
                stepStartTime = Date.now();
                context.log(`[${correlationId}] [CHAT_STATUS: SEARCH_START] Step 2B: Searching index "finance-hr-documents" with filter="${searchFilter || 'NONE'}"...`);
                const chunks = await searchSimilar(queryVector, {
                    top: 4,
                    filter: searchFilter,
                    searchText: question
                });
                context.log(`[${correlationId}] [CHAT_STATUS: SEARCH_COMPLETE] Step 2B: Retrieved ${chunks.length} matching search chunk(s) in ${Date.now() - stepStartTime}ms.`);

                // 3. Format sources
                formattedSources = formatSourceReferences(chunks);

                // 4. Synthesize Answer
                currentStep = 'FLOW B: LLM SEARCH ANSWER SYNTHESIS';
                stepStartTime = Date.now();
                context.log(`[${correlationId}] === ${currentStep} ===`);
                context.log(`[${correlationId}] [CHAT_STATUS: SYNTHESIS_START] Flow B: Synthesizing answer with ${chunks.length} retrieval chunk(s)...`);

                const llmResult = await generateAnswer(question, chunks, [], []);
                finalAnswer = llmResult.answer;
                insufficientEvidence = llmResult.insufficientEvidence;

                context.log(`[${correlationId}] [CHAT_STATUS: SYNTHESIS_COMPLETE] Flow B Completed: Synthesized answer (${finalAnswer.length} chars, InsufficientEvidence=${insufficientEvidence}) in ${Date.now() - stepStartTime}ms.`);
            }

            // =========================================================================
            // RESPONSE ASSEMBLY
            // =========================================================================
            const totalElapsedMs = Date.now() - reqStartTime;
            context.log(`[${correlationId}] [CHAT_STATUS: COMPLETED] >>> CHAT REQUEST COMPLETED SUCCESSFULLY <<< Route=${routeUsed}, Sources=${formattedSources.length}, FactsUsed=${relevantFacts.length}, Calculations=${calculations.length}, InsufficientEvidence=${insufficientEvidence}, TotalDuration=${totalElapsedMs}ms, HTTPStatus=200`);

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
                    durationMs: totalElapsedMs,
                    correlationId
                })
            };

        } catch (error) {
            const totalElapsedMs = Date.now() - reqStartTime;
            context.error(`[${correlationId}] [CHAT_STATUS: FAILED] !!! CHAT FAILED AT [${currentStep}] !!! TotalDuration=${totalElapsedMs}ms`);
            context.error(`[${correlationId}] Error: ${error.message}`);
            if (error.stack) context.error(`[${correlationId}] Stack: ${error.stack}`);
            return toErrorResponse(error, correlationId);
        }
    }
});
