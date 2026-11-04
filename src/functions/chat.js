const { app } = require('@azure/functions');
const { validateChatRequest } = require('../utils/validation');
const { toErrorResponse, NotFoundError } = require('../utils/errors');
const { generateEmbedding } = require('../services/embeddings');
const { searchSimilar } = require('../services/azure-search');
const { getDocumentById } = require('../services/sql');
const { getFactsWithConflictContext } = require('../services/conflict-resolver');
const { evaluateDeterministicCalculations } = require('../services/calculation-engine');
const { findRelevantStructuredFacts, formatSourceReferences } = require('../services/evidence-validation');
const { generateAnswer } = require('../services/answer-generation');

app.http('chat', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const correlationId = `chat-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        context.log(`[${correlationId}] Chat request received`);

        try {
            const body = await request.json().catch(() => null);
            const { question, documentId } = validateChatRequest(body);
            context.log(`[${correlationId}] Question: "${question}", documentId: ${documentId || 'all'}`);

            let targetDoc = null;
            let searchFilter = null;

            // 1. If documentId is provided, check status in SQL
            if (documentId) {
                targetDoc = await getDocumentById(documentId);
                if (!targetDoc) {
                    throw new NotFoundError(`Document with ID or name "${documentId}" was not found.`);
                }

                if (targetDoc.IngestionStatus === 'Processing') {
                    return {
                        status: 409,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            answer: `Document "${targetDoc.FileName}" is currently being processed. Please try again shortly.`,
                            documentId: targetDoc.DocumentId,
                            status: 'PROCESSING',
                            sources: [],
                            insufficientEvidence: true
                        })
                    };
                }

                if (targetDoc.IngestionStatus === 'Failed') {
                    return {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            answer: `Ingestion previously failed for document "${targetDoc.FileName}". Please re-ingest the document.`,
                            documentId: targetDoc.DocumentId,
                            status: 'FAILED',
                            sources: [],
                            insufficientEvidence: true
                        })
                    };
                }

                searchFilter = `source eq '${targetDoc.FileName.replace(/'/g, "''")}'`;
            }

            // 2. Query SQL for validated facts with governance & conflict context
            const allFacts = await getFactsWithConflictContext(targetDoc ? targetDoc.DocumentId : null);
            const relevantFacts = findRelevantStructuredFacts(question, allFacts);
            context.log(`[${correlationId}] Retrieved ${relevantFacts.length} relevant structured fact(s) from SQL`);

            // 3. Evaluate deterministic calculations (variances, category sums, discrepancies)
            const calculations = evaluateDeterministicCalculations(question, relevantFacts);
            if (calculations.length > 0) {
                context.log(`[${correlationId}] Evaluated ${calculations.length} deterministic calculation(s)`);
            }

            // 4. Generate vector embedding for question
            context.log(`[${correlationId}] Generating embedding for question...`);
            const queryVector = await generateEmbedding(question);

            // 5. Vector search in Azure AI Search
            context.log(`[${correlationId}] Searching Azure AI Search chunks...`);
            const chunks = await searchSimilar(queryVector, {
                top: 4,
                filter: searchFilter
            });
            context.log(`[${correlationId}] Retrieved ${chunks.length} matching search chunk(s)`);

            // 6. Generate grounded answer via LLM
            context.log(`[${correlationId}] Generating evidence-based answer...`);
            const { answer, insufficientEvidence } = await generateAnswer(question, chunks, relevantFacts, calculations);

            // 7. Format verified citation sources
            const formattedSources = formatSourceReferences(chunks);

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    answer,
                    documentId: targetDoc ? targetDoc.DocumentId : (chunks[0]?.documentId || null),
                    sources: formattedSources,
                    factsUsed: relevantFacts.map(f => ({
                        metric: f.Metric,
                        entity: f.Entity,
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
                    insufficientEvidence
                })
            };

        } catch (error) {
            context.error(`[${correlationId}] Chat error: ${error.message}`);
            return toErrorResponse(error, correlationId);
        }
    }
});
