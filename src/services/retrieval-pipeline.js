/**
 * Finora AI Complete 11-Stage Retrieval Pipeline
 *
 * Modeled after the 10-step ingestion pipeline (ingestion-pipeline.js).
 * Coordinates the full retrieval lifecycle for financial and HR queries:
 *
 *   STAGE 1: QUERY INPUT
 *   STAGE 2: QUERY PREPROCESSING (Arabic/English detection, numeral normalization, follow-up reference resolution)
 *   STAGE 3: INTENT CLASSIFICATION (DIRECT_SQL vs AZURE_SEARCH)
 *   STAGE 4: QUERY VALIDATION (Route & constraint integrity checks)
 *   STAGE 5: ROUTE-BASED RETRIEVAL (SQL facts vs Azure AI Search chunks)
 *   STAGE 6: RESULT FILTERING & RELEVANCE RANKING (Post-retrieval canonical metric/entity/period scoping)
 *   STAGE 7: CONFLICT DETECTION & RESOLUTION (Source authority ranking & governance review)
 *   STAGE 8: CALCULATION & CONTEXT PREPARATION (Deterministic period comparison & arithmetic)
 *   STAGE 9: ANSWER GENERATION (Grounded LLM answer synthesis)
 *   STAGE 10: RESPONSE VALIDATION (Evidence verification, provenance & source citations)
 *   STAGE 11: LOGGING & RESPONSE DELIVERY (Exact API contract preservation)
 */

require('../utils/config');
const {
    validateAndPreserveInput,
    detectLanguage,
    normalizeArabicNumerals,
    resolveConversationalReferences,
    preprocessQuery
} = require('./query-preprocessor');
const { classifyIntent, classifyIntentByRules, extractEntitiesFromQuestion, extractMetricsFromQuestion } = require('./intent-classifier');
const { findRelevantStructuredFacts, BRAND_STOP_WORDS } = require('./evidence-validation');
const { getFactsWithConflictContext } = require('./conflict-resolver');
const { evaluateDeterministicCalculations, computePeriodComparison } = require('./calculation-engine');
const { generateAnswer, buildConflictAnswer, appendConflictDetailsToAnswer } = require('./answer-generation');
const { generateEmbedding } = require('./embeddings');
const { searchSimilar } = require('./azure-search');
const { validateRetrievalResponse, isInsufficientEvidence } = require('./response-validator');

// =========================================================================
// STAGE 1: QUERY INPUT
// =========================================================================
function stage1QueryInput(options = {}) {
    return validateAndPreserveInput(options.question);
}

// =========================================================================
// STAGE 2: QUERY PREPROCESSING
// =========================================================================
function stage2QueryPreprocessing(stage1Output, conversationHistory = []) {
    return preprocessQuery(stage1Output.originalQuestion, conversationHistory);
}

// =========================================================================
// STAGE 3: INTENT CLASSIFICATION
// =========================================================================
async function stage3IntentClassification(stage2Output) {
    const question = stage2Output.preprocessedQuestion;
    const intent = await classifyIntent(question);

    // Enforce strictly two routes: DIRECT_SQL or AZURE_SEARCH
    const route = (intent.route === 'DIRECT_SQL' || intent.route === 'AZURE_SEARCH')
        ? intent.route
        : 'AZURE_SEARCH';

    return {
        ...stage2Output,
        intent: {
            ...intent,
            route
        }
    };
}

// =========================================================================
// STAGE 4: QUERY VALIDATION
// =========================================================================
function stage4QueryValidation(stage3Output) {
    const { intent } = stage3Output;

    // Validate route integrity
    let validRoute = intent.route;
    if (validRoute !== 'DIRECT_SQL' && validRoute !== 'AZURE_SEARCH') {
        validRoute = 'AZURE_SEARCH';
    }

    // Sanitize metrics, entities, periods
    const metrics = Array.isArray(intent.metrics) ? intent.metrics.map(m => String(m).trim()).filter(Boolean) : [];
    const entities = Array.isArray(intent.entities) ? intent.entities.map(e => String(e).trim()).filter(Boolean) : [];
    const periods = Array.isArray(intent.periods) ? intent.periods.map(p => String(p).trim()).filter(Boolean) : [];

    const confidence = typeof intent.confidence === 'number' ? intent.confidence : 0.85;
    const intentType = intent.intentType || (intent.isComparison ? 'PERIOD_COMPARISON' : 'SINGLE_PERIOD_FACT');

    return {
        ...stage3Output,
        intent: {
            ...intent,
            route: validRoute,
            metrics,
            entities,
            periods,
            confidence,
            intentType
        }
    };
}

// =========================================================================
// STAGE 5: ROUTE-BASED RETRIEVAL
// =========================================================================
async function stage5RouteRetrieval(stage4Output, targetDocument = null, searchFilter = null, log = console.log) {
    const { intent, preprocessedQuestion } = stage4Output;
    let rawFacts = [];
    let rawChunks = [];

    if (intent.route === 'DIRECT_SQL') {
        // Direct SQL fact retrieval with governance/conflict context
        rawFacts = await getFactsWithConflictContext(targetDocument ? targetDocument.DocumentId : null);
    } else {
        // Azure AI Search vector & keyword hybrid retrieval
        const queryVector = await generateEmbedding(preprocessedQuestion);

        let effectiveSearchFilter = searchFilter;
        if (!effectiveSearchFilter && intent.entities && intent.entities.length > 0) {
            const entityFilters = intent.entities.flatMap(e => {
                const words = e.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !BRAND_STOP_WORDS.has(w));
                return words.map(w => `search.ismatch('${w.replace(/'/g, "''")}', 'entity')`);
            });
            if (entityFilters.length > 0) {
                effectiveSearchFilter = entityFilters.join(' or ');
            }
        }

        try {
            rawChunks = await searchSimilar(queryVector, {
                top: 3,
                filter: effectiveSearchFilter,
                searchText: preprocessedQuestion
            });
        } catch (searchErr) {
            log(`[Stage 5 Warning] Filtered search failed: ${searchErr.message}. Retrying without filter...`);
        }

        // Retry without filter if filtered search returned 0 results
        if (rawChunks.length === 0 && effectiveSearchFilter && !searchFilter) {
            rawChunks = await searchSimilar(queryVector, {
                top: 3,
                filter: null,
                searchText: preprocessedQuestion
            });
        }
    }

    return {
        ...stage4Output,
        targetDocument,
        searchFilter,
        rawFacts,
        rawChunks
    };
}

// =========================================================================
// STAGE 6: RESULT FILTERING AND RELEVANCE RANKING
// =========================================================================
async function stage6ResultFiltering(stage5Output, log = console.log) {
    const { intent, preprocessedQuestion, rawFacts, rawChunks } = stage5Output;
    let routeUsed = intent.route;
    let retainedFacts = [];
    let retainedChunks = [];
    let filterStats = null;

    if (routeUsed === 'DIRECT_SQL') {
        // Direct structured fact scoping via canonical entity, period, and metric matching
        retainedFacts = findRelevantStructuredFacts(preprocessedQuestion, rawFacts, intent);
        filterStats = {
            totalRetrieved: rawFacts.length,
            retainedCount: retainedFacts.length,
            excludedCount: rawFacts.length - retainedFacts.length
        };

        // If 0 SQL facts matched entity/metric/period constraints, fallback seamlessly to Azure AI Search
        if (retainedFacts.length === 0) {
            log(`[Stage 6 Notice] 0 SQL facts retained. Falling back to Azure AI Search...`);
            routeUsed = 'AZURE_SEARCH';

            const queryVector = await generateEmbedding(preprocessedQuestion);
            let fallbackChunks = [];
            try {
                fallbackChunks = await searchSimilar(queryVector, {
                    top: 3,
                    filter: null,
                    searchText: preprocessedQuestion
                });
            } catch (err) {
                log(`[Stage 6 Warning] Fallback search error: ${err.message}`);
            }
            retainedChunks = fallbackChunks;
        }
    } else {
        retainedChunks = rawChunks;
    }

    return {
        ...stage5Output,
        routeUsed,
        retainedFacts,
        retainedChunks,
        filterStats
    };
}

// =========================================================================
// STAGE 7: CONFLICT DETECTION AND RESOLUTION
// =========================================================================
function stage7ConflictDetection(stage6Output) {
    const { routeUsed, retainedFacts, preprocessedQuestion } = stage6Output;

    let hasUnresolvedConflict = false;
    let conflictAnswer = null;

    if (routeUsed === 'DIRECT_SQL') {
        const unresolvedConflicts = (retainedFacts || []).filter(
            f => f.hasConflict === true && (f.conflictStatus || '').includes('Unresolved')
        );
        const resolvedConflicts = (retainedFacts || []).filter(
            f => f.hasConflict === true && !(f.conflictStatus || '').includes('Unresolved')
        );

        if (unresolvedConflicts.length > 0) {
            hasUnresolvedConflict = true;
            conflictAnswer = buildConflictAnswer(preprocessedQuestion, unresolvedConflicts, resolvedConflicts);
        } else if (resolvedConflicts.length > 0 && retainedFacts.every(f => f.hasConflict)) {
            conflictAnswer = buildConflictAnswer(preprocessedQuestion, [], resolvedConflicts);
        }
    }

    return {
        ...stage6Output,
        hasUnresolvedConflict,
        conflictAnswer
    };
}

// =========================================================================
// STAGE 8: CALCULATION AND CONTEXT PREPARATION
// =========================================================================
function stage8CalculationPreparation(stage7Output, log = console.log) {
    const { routeUsed, retainedFacts, intent, preprocessedQuestion } = stage7Output;
    const calculations = [];

    if (routeUsed === 'DIRECT_SQL') {
        const mathCalcs = evaluateDeterministicCalculations(preprocessedQuestion, retainedFacts, intent);
        if (mathCalcs.length > 0) {
            calculations.push(...mathCalcs);
            log(`[Stage 8 Output] Evaluated ${mathCalcs.length} deterministic calculation(s).`);
        }
    }

    return {
        ...stage7Output,
        calculations
    };
}

// =========================================================================
// STAGE 9: ANSWER GENERATION
// =========================================================================
async function stage9AnswerGeneration(stage8Output) {
    const {
        routeUsed,
        preprocessedQuestion,
        retainedFacts,
        retainedChunks,
        calculations,
        hasUnresolvedConflict,
        conflictAnswer
    } = stage8Output;

    // If unresolved conflict detected, bypass LLM to prevent arbitrary number guessing
    if (hasUnresolvedConflict && conflictAnswer) {
        return {
            ...stage8Output,
            answer: conflictAnswer,
            insufficientEvidence: false
        };
    }

    const chunksToPass = routeUsed === 'AZURE_SEARCH' ? retainedChunks : [];
    const factsToPass = routeUsed === 'DIRECT_SQL' ? retainedFacts : [];

    const llmResult = await generateAnswer(preprocessedQuestion, chunksToPass, factsToPass, calculations);

    let answerText = llmResult.answer;
    if (routeUsed === 'DIRECT_SQL' && retainedFacts && retainedFacts.length > 0) {
        answerText = appendConflictDetailsToAnswer(answerText, retainedFacts);
    }

    return {
        ...stage8Output,
        answer: answerText,
        insufficientEvidence: llmResult.insufficientEvidence,
        hasUnresolvedConflict: llmResult.hasUnresolvedConflict || hasUnresolvedConflict
    };
}

// =========================================================================
// STAGE 10: RESPONSE VALIDATION
// =========================================================================
async function stage10ResponseValidation(stage9Output, log = console.log) {
    let {
        routeUsed,
        answer,
        insufficientEvidence,
        retainedFacts,
        retainedChunks,
        preprocessedQuestion,
        calculations,
        hasUnresolvedConflict,
        targetDocument,
        intent
    } = stage9Output;

    // Fallback trigger: If SQL route returned insufficient evidence, attempt Azure AI Search
    if (routeUsed === 'DIRECT_SQL' && insufficientEvidence) {
        log(`[Stage 10 Fallback] SQL answer indicated insufficient evidence. Falling back to Azure AI Search chunks...`);
        const queryVector = await generateEmbedding(preprocessedQuestion);
        const fallbackChunks = await searchSimilar(queryVector, {
            top: 3,
            filter: null,
            searchText: preprocessedQuestion
        });

        if (fallbackChunks.length > 0) {
            const fallbackResult = await generateAnswer(preprocessedQuestion, fallbackChunks, [], calculations);
            if (!fallbackResult.insufficientEvidence || !answer) {
                routeUsed = 'AZURE_SEARCH';
                answer = fallbackResult.answer;
                insufficientEvidence = fallbackResult.insufficientEvidence;
                hasUnresolvedConflict = fallbackResult.hasUnresolvedConflict || false;
                retainedChunks = fallbackChunks;
            }
        }
    }

    // POST-ANSWER SQL ENRICHMENT (AZURE_SEARCH route)
    // When AZURE_SEARCH generated the answer, the answer text often names a specific entity
    // (e.g. "Contoso Logistics LLC") that the original query left ambiguous ("Contoso LLC").
    // Extract that entity from the answer, do a targeted SQL fact lookup, and populate
    // retainedFacts so factsUsed is never empty for financial metric queries.
    if (routeUsed === 'AZURE_SEARCH' && answer && !insufficientEvidence &&
        intent && intent.metrics && intent.metrics.length > 0 &&
        (!retainedFacts || retainedFacts.length === 0)) {
        try {
            // Extract specific entity names mentioned in the answer text
            const entitiesFromAnswer = extractEntitiesFromQuestion(answer);
            const entitiesToQuery = entitiesFromAnswer.length > 0
                ? entitiesFromAnswer
                : (intent.entities && intent.entities.length > 0 ? intent.entities : []);

            if (entitiesToQuery.length > 0) {
                log(`[Stage 10 Enrichment] Extracting SQL facts for entities found in answer: [${entitiesToQuery.join(', ')}]`);
                const allFacts = await getFactsWithConflictContext(null);
                const enrichedIntent = { ...intent, entities: entitiesToQuery };
                const sqlFacts = findRelevantStructuredFacts(preprocessedQuestion, allFacts, enrichedIntent);
                if (sqlFacts.length > 0) {
                    retainedFacts = sqlFacts;
                    log(`[Stage 10 Enrichment] Populated factsUsed with ${sqlFacts.length} SQL fact(s) from answer-extracted entities.`);
                }
            }
        } catch (enrichErr) {
            log(`[Stage 10 Warning] Post-answer SQL enrichment failed: ${enrichErr.message}`);
        }
    }

    const validationResult = validateRetrievalResponse({
        answer,
        routeUsed,
        retainedFacts,
        retainedChunks,
        hasUnresolvedConflict,
        insufficientEvidence,
        targetDocument
    });

    return {
        ...stage9Output,
        routeUsed,
        retainedFacts,          // carry enriched facts forward (may differ from stage9Output.retainedFacts)
        answer: validationResult.answer,
        insufficientEvidence: validationResult.insufficientEvidence,
        hasUnresolvedConflict: validationResult.hasUnresolvedConflict,
        formattedSources: validationResult.formattedSources,
        factsUsedOutput: validationResult.factsUsedOutput,
        resolvedDocumentId: validationResult.resolvedDocumentId,
        documentName: validationResult.documentName,
        pageNumber: validationResult.pageNumber,
        grounded: validationResult.grounded
    };
}

// =========================================================================
// STAGE 11: LOGGING AND RESPONSE DELIVERY
// =========================================================================
function stage11LoggingAndDelivery(stage10Output, correlationId, log = console.log) {
    const {
        routeUsed,
        intent,
        answer,
        hasUnresolvedConflict,
        resolvedDocumentId,
        documentName,
        pageNumber,
        formattedSources,
        factsUsedOutput,
        calculations,
        insufficientEvidence,
        language,
        grounded
    } = stage10Output;

    log(`=== STAGE 11: RESPONSE DELIVERY ===`);
    log(`[${correlationId}] Route Used: ${routeUsed}`);
    log(`[${correlationId}] Language: ${language}`);
    log(`[${correlationId}] Sources Count: ${formattedSources.length}`);
    log(`[${correlationId}] Facts Used Count: ${factsUsedOutput.length}`);
    log(`[${correlationId}] Has Conflict: ${hasUnresolvedConflict}`);
    log(`[${correlationId}] Grounded: ${grounded}`);
    log(`[${correlationId}] Insufficient Evidence: ${insufficientEvidence}`);

    return {
        status: 'success',
        routeUsed,
        intentType: intent.intentType,
        entitiesDetected: intent.entities || [],
        periodsDetected: intent.periods || [],
        metricsDetected: intent.metrics || [],
        answer,
        language,
        grounded,
        hasUnresolvedConflict,
        documentId: resolvedDocumentId,
        document_name: documentName,
        page: pageNumber,
        sources: formattedSources,
        factsUsed: factsUsedOutput,
        calculations,
        insufficientEvidence,
        correlationId
    };
}

/**
 * Orchestrates the full 11-stage enterprise retrieval pipeline.
 * Modeled after processDocumentIngestion in ingestion-pipeline.js.
 *
 * @param {Object} options
 * @param {string} options.question - Raw user question
 * @param {Object} [options.targetDocument] - Pre-authenticated document
 * @param {string} [options.searchFilter] - Pre-built search filter
 * @param {Array}  [options.conversationHistory] - Previous chat messages
 * @param {string} [options.correlationId] - Correlation ID for tracing
 * @param {Object} [options.logger] - Logger or context
 * @returns {Promise<Object>} API response payload
 */
async function processRetrievalPipeline({
    question,
    targetDocument = null,
    searchFilter = null,
    conversationHistory = null,
    correlationId = null,
    logger = console
}) {
    const corrId = correlationId || `retrieve-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const log = (msg) => (logger.log ? logger.log(`[${corrId}] ${msg}`) : console.log(`[${corrId}] ${msg}`));
    const errorLog = (msg) => (logger.error ? logger.error(`[${corrId}] ${msg}`) : console.error(`[${corrId}] ${msg}`));

    let currentStep = 'INITIALIZATION';

    try {
        // STAGE 1: QUERY INPUT
        currentStep = 'STAGE 1: QUERY INPUT';
        log(`=== ${currentStep} ===`);
        const s1 = stage1QueryInput({ question });
        log(`Stage 1 Output: Question received (${s1.originalQuestion.length} chars).`);

        // STAGE 2: QUERY PREPROCESSING
        currentStep = 'STAGE 2: QUERY PREPROCESSING';
        log(`=== ${currentStep} ===`);
        const s2 = stage2QueryPreprocessing(s1, conversationHistory);
        log(`Stage 2 Output: Language=${s2.language}, Preprocessed="${s2.preprocessedQuestion}".`);

        // STAGE 3: INTENT CLASSIFICATION
        currentStep = 'STAGE 3: INTENT CLASSIFICATION';
        log(`=== ${currentStep} ===`);
        const s3 = await stage3IntentClassification(s2);
        log(`Stage 3 Output: Route=${s3.intent.route}, Type=${s3.intent.intentType}, Confidence=${s3.intent.confidence}.`);

        // STAGE 4: QUERY VALIDATION
        currentStep = 'STAGE 4: QUERY VALIDATION';
        log(`=== ${currentStep} ===`);
        const s4 = stage4QueryValidation(s3);
        log(`Stage 4 Output: Validated Route=${s4.intent.route}, Metrics=[${s4.intent.metrics.join(', ')}], Entities=[${s4.intent.entities.join(', ')}], Periods=[${s4.intent.periods.join(', ')}].`);

        // STAGE 5: ROUTE-BASED RETRIEVAL
        currentStep = 'STAGE 5: ROUTE-BASED RETRIEVAL';
        log(`=== ${currentStep} ===`);
        const s5 = await stage5RouteRetrieval(s4, targetDocument, searchFilter, log);
        log(`Stage 5 Output: Retrieved ${s5.rawFacts.length} SQL fact(s), ${s5.rawChunks.length} search chunk(s).`);

        // STAGE 6: RESULT FILTERING AND RELEVANCE RANKING
        currentStep = 'STAGE 6: RESULT FILTERING AND RELEVANCE RANKING';
        log(`=== ${currentStep} ===`);
        const s6 = await stage6ResultFiltering(s5, log);
        log(`Stage 6 Output: Route=${s6.routeUsed}, Retained Facts=${s6.retainedFacts.length}, Retained Chunks=${s6.retainedChunks.length}.`);

        // STAGE 7: CONFLICT DETECTION AND RESOLUTION
        currentStep = 'STAGE 7: CONFLICT DETECTION AND RESOLUTION';
        log(`=== ${currentStep} ===`);
        const s7 = stage7ConflictDetection(s6);
        log(`Stage 7 Output: Has Unresolved Conflict=${s7.hasUnresolvedConflict}.`);

        // STAGE 8: CALCULATION AND CONTEXT PREPARATION
        currentStep = 'STAGE 8: CALCULATION AND CONTEXT PREPARATION';
        log(`=== ${currentStep} ===`);
        const s8 = stage8CalculationPreparation(s7, log);
        log(`Stage 8 Output: Prepared ${s8.calculations.length} calculation(s).`);

        // STAGE 9: ANSWER GENERATION
        currentStep = 'STAGE 9: ANSWER GENERATION';
        log(`=== ${currentStep} ===`);
        const s9 = await stage9AnswerGeneration(s8);
        log(`Stage 9 Output: Generated answer (${(s9.answer || '').length} chars).`);

        // STAGE 10: RESPONSE VALIDATION
        currentStep = 'STAGE 10: RESPONSE VALIDATION';
        log(`=== ${currentStep} ===`);
        const s10 = await stage10ResponseValidation(s9, log);
        log(`Stage 10 Output: Grounded=${s10.grounded}, Sources=${s10.formattedSources.length}, Facts Used=${s10.factsUsedOutput.length}.`);

        // STAGE 11: LOGGING AND RESPONSE DELIVERY
        currentStep = 'STAGE 11: LOGGING AND RESPONSE DELIVERY';
        log(`=== ${currentStep} ===`);
        const finalResponse = stage11LoggingAndDelivery(s10, corrId, log);
        log(`>>> RETRIEVAL PIPELINE FINISHED SUCCESSFULLY <<<`);

        return finalResponse;

    } catch (err) {
        errorLog(`!!! RETRIEVAL PIPELINE FAILED AT [${currentStep}] !!!`);
        errorLog(`Error Name: ${err.name || 'Error'}`);
        errorLog(`Error Message: ${err.message}`);
        if (err.stack) {
            errorLog(`Error Stack Trace: ${err.stack}`);
        }
        throw err;
    }
}

module.exports = {
    processRetrievalPipeline,
    executeRetrievalPipeline: processRetrievalPipeline, // Alias for seamless compatibility
    stage1QueryInput,
    stage2QueryPreprocessing,
    stage3IntentClassification,
    stage4QueryValidation,
    stage5RouteRetrieval,
    stage6ResultFiltering,
    stage7ConflictDetection,
    stage8CalculationPreparation,
    stage9AnswerGeneration,
    stage10ResponseValidation,
    stage11LoggingAndDelivery,
    detectLanguage,
    normalizeArabicNumerals,
    resolveConversationalReferences
};