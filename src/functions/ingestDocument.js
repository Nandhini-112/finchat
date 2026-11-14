const { app } = require('@azure/functions');
const { validateDocumentBuffer } = require('../utils/validation');
const { ValidationError, toErrorResponse } = require('../utils/errors');
const { processDocumentIngestion } = require('../services/ingestion-pipeline');
const { blankToNull } = require('../services/search-document');
const {
    createDocument,
    startIngestionRun,
    updateIngestionRunProgress,
    completeIngestionRun
} = require('../services/sql');

function firstText(...values) {
    for (const value of values) {
        const text = blankToNull(value);
        if (text) return text;
    }
    return null;
}

const CONCURRENCY_LIMIT = 3;

/**
 * Creates a background-safe logger detached from the HTTP invocation context.
 * Prevents Azure Functions "Warning: Unexpected call to 'log' on the context object after function execution has completed."
 */
function createBackgroundLogger(correlationId) {
    const ts = () => new Date().toISOString();
    return {
        log: (msg) => console.log(`[${ts()}] [${correlationId}] ${msg}`),
        warn: (msg) => console.warn(`[${ts()}] [${correlationId}] [WARN] ${msg}`),
        error: (msg) => console.error(`[${ts()}] [${correlationId}] [ERROR] ${msg}`),
        info: (msg) => console.info(`[${ts()}] [${correlationId}] ${msg}`)
    };
}

app.http('ingestDocument', {
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: async (request, context) => {
        const correlationId = `ingest-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
        context.log(`[${correlationId}] >>> START INGESTION REQUEST <<< Method=POST, URL=${request.url}`);

        try {
            context.log(`[${correlationId}] === STEP 1: VALIDATION & INPUT EXTRACTION ===`);

            const contentType = (request.headers.get('content-type') || '').toLowerCase();
            const filesToProcess = [];

            // 1. Extract filename from query string (case-insensitive)
            let defaultFileName = null;
            if (request.query) {
                for (const [key, val] of request.query.entries()) {
                    if (/^(filename|name|file|title)$/i.test(key) && val) {
                        defaultFileName = decodeURIComponent(val).trim();
                        break;
                    }
                }
            }

            // 2. Check headers (x-filename, x-file-name, content-disposition)
            if (!defaultFileName) {
                const xFn = request.headers.get('x-filename') || request.headers.get('x-file-name');
                if (xFn) defaultFileName = decodeURIComponent(xFn).trim();
            }

            if (!defaultFileName) {
                const disp = request.headers.get('content-disposition') || '';
                const match = disp.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i);
                if (match && match[1]) defaultFileName = decodeURIComponent(match[1]).trim();
            }

            let allowedUserGroups = request.query.get('allowedUserGroups') || request.headers.get('x-user-groups') || null;
            let authorityRank = Number(request.query.get('authorityRank') || request.headers.get('x-authority-rank') || 4);
            let sourceType = request.query.get('sourceType') || request.headers.get('x-source-type') || 'ManualUpload';
            let documentKey = firstText(request.query.get('documentKey'), request.headers.get('x-document-key'));
            let queueKey = firstText(request.query.get('queueKey'), request.headers.get('x-queue-key'));
            let fileLink = firstText(request.query.get('fileLink'), request.headers.get('x-file-link'));
            let department = firstText(request.query.get('department'), request.headers.get('x-department'));
            let jobTitle = firstText(request.query.get('jobTitle'), request.headers.get('x-job-title'));
            let modifiedDate = firstText(request.query.get('modifiedDate'), request.headers.get('x-modified-date'));
            let modifiedByEmail = firstText(
                request.query.get('modifiedByEmail'),
                request.headers.get('x-modified-by-email'),
                request.headers.get('x-user-email'),
                request.headers.get('x-modified-user')
            );
            let modifiedByName = firstText(
                request.query.get('modifiedByName'),
                request.headers.get('x-modified-by-name'),
                request.headers.get('x-user-name')
            );

            // Check async parameter (?async=false allows synchronous mode if explicitly requested)
            const isAsync = request.query.get('async') !== 'false' && request.headers.get('x-async') !== 'false';

            if (contentType.includes('text/plain') || contentType.includes('text/markdown') || contentType.includes('text/csv')) {
                const textContent = await request.text();
                const fileBuffer = Buffer.from(textContent, 'utf8');
                const fileName = defaultFileName || `report_${Date.now()}.${contentType.includes('csv') ? 'csv' : 'txt'}`;
                filesToProcess.push({ fileBuffer, fileName });
            } else if (contentType.includes('application/pdf') ||
                contentType.includes('application/octet-stream') ||
                contentType.includes('spreadsheetml') ||
                contentType.includes('ms-excel')) {
                const arrayBuffer = await request.arrayBuffer();
                const fileBuffer = Buffer.from(arrayBuffer);
                filesToProcess.push({ fileBuffer, fileName: defaultFileName });
            } else if (contentType.includes('multipart/form-data')) {
                const formData = await request.formData();

                // Metadata overrides from form fields
                if (formData.get('allowedUserGroups')) allowedUserGroups = formData.get('allowedUserGroups');
                if (formData.get('authorityRank')) authorityRank = Number(formData.get('authorityRank'));
                if (formData.get('sourceType')) sourceType = formData.get('sourceType');
                documentKey = firstText(formData.get('documentKey'), documentKey);
                queueKey = firstText(formData.get('queueKey'), queueKey);
                fileLink = firstText(formData.get('fileLink'), fileLink);
                department = firstText(formData.get('department'), department);
                jobTitle = firstText(formData.get('jobTitle'), jobTitle);
                modifiedDate = firstText(formData.get('modifiedDate'), modifiedDate);
                modifiedByEmail = firstText(formData.get('modifiedByEmail'), formData.get('userEmail'), modifiedByEmail);
                modifiedByName = firstText(formData.get('modifiedByName'), formData.get('userName'), modifiedByName);

                // Collect all files uploaded in formData (supports single and multiple files)
                for (const [key, val] of formData.entries()) {
                    if (val && typeof val.arrayBuffer === 'function') {
                        const arrayBuffer = await val.arrayBuffer();
                        const fileBuffer = Buffer.from(arrayBuffer);
                        let fn = val.name || null;
                        filesToProcess.push({ fileBuffer, fileName: fn });
                    }
                }

                if (filesToProcess.length === 1 && formData.get('fileName')) {
                    filesToProcess[0].fileName = formData.get('fileName');
                }

                if (filesToProcess.length === 0) {
                    throw new ValidationError('form-data request must include one or more files in "file", "document", or "files" fields.');
                }
            } else if (contentType.includes('application/json')) {
                const jsonBody = await request.json().catch(() => null);
                if (!jsonBody) throw new ValidationError('JSON body is malformed or empty.');

                let fileName = defaultFileName || jsonBody.fileName || jsonBody.filename;
                allowedUserGroups = allowedUserGroups || jsonBody.allowedUserGroups || null;
                if (jsonBody.authorityRank) authorityRank = Number(jsonBody.authorityRank);
                if (jsonBody.sourceType) sourceType = jsonBody.sourceType;
                documentKey = firstText(jsonBody.documentKey, documentKey);
                queueKey = firstText(jsonBody.queueKey, queueKey);
                fileLink = firstText(jsonBody.fileLink, fileLink);
                department = firstText(jsonBody.department, department);
                jobTitle = firstText(jsonBody.jobTitle, jobTitle);
                modifiedDate = firstText(jsonBody.modifiedDate, modifiedDate);
                modifiedByEmail = firstText(jsonBody.modifiedByEmail, jsonBody.userEmail, modifiedByEmail);
                modifiedByName = firstText(jsonBody.modifiedByName, jsonBody.userName, modifiedByName);

                let fileBuffer;
                if (jsonBody.text || jsonBody.content) {
                    fileBuffer = Buffer.from(jsonBody.text || jsonBody.content, 'utf8');
                    fileName = fileName || `report_${Date.now()}.txt`;
                } else if (jsonBody.base64) {
                    fileBuffer = Buffer.from(jsonBody.base64, 'base64');
                } else {
                    throw new ValidationError('JSON request must include "text", "content", or "base64".');
                }
                filesToProcess.push({ fileBuffer, fileName });
            } else {
                throw new ValidationError(`Unsupported Content-Type: "${contentType}". Finora AI accepts form-data, PDF/Binary, CSV, Excel (.xlsx/.xls), Text, or JSON.`);
            }

            // Sanitize file names and validate each buffer upfront synchronously
            for (let i = 0; i < filesToProcess.length; i++) {
                const item = filesToProcess[i];
                const isPdf = item.fileBuffer && item.fileBuffer.length >= 4 && item.fileBuffer.toString('utf8', 0, 4) === '%PDF';
                const isZipOrExcel = item.fileBuffer && item.fileBuffer.length >= 4 && item.fileBuffer.toString('hex', 0, 4) === '504b0304';

                if (item.fileName) {
                    if (!item.fileName.includes('.')) {
                        if (isPdf) item.fileName += '.pdf';
                        else if (isZipOrExcel) item.fileName += '.xlsx';
                        else if (contentType.includes('csv')) item.fileName += '.csv';
                        else item.fileName += '.txt';
                    }
                } else {
                    const timestamp = Date.now() + i;
                    if (isPdf) item.fileName = `document_${timestamp}.pdf`;
                    else if (isZipOrExcel) item.fileName = `spreadsheet_${timestamp}.xlsx`;
                    else if (contentType.includes('csv')) item.fileName = `data_${timestamp}.csv`;
                    else item.fileName = `document_${timestamp}.txt`;
                }

                await validateDocumentBuffer(item.fileBuffer, item.fileName);
                context.log(`[${correlationId}] File [${i + 1}/${filesToProcess.length}] validated: "${item.fileName}" (${(item.fileBuffer.length / 1024).toFixed(1)} KB).`);
            }

            // -------------------------------------------------------------------------
            // ASYNCHRONOUS INGESTION (DEFAULT)
            // -------------------------------------------------------------------------
            if (isAsync) {
                // Pre-register all documents in Azure SQL immediately (Status: Processing)
                const registeredDocs = [];
                for (const item of filesToProcess) {
                    const docId = await createDocument(item.fileName, sourceType, authorityRank, allowedUserGroups, {
                        modifiedByEmail,
                        modifiedByName,
                        modifiedDate,
                        department
                    });
                    registeredDocs.push({
                        documentId: docId,
                        fileName: item.fileName,
                        fileBuffer: item.fileBuffer,
                        status: 'Processing'
                    });
                    context.log(`[${correlationId}] Pre-registered DocumentId=${docId} for "${item.fileName}" (Status: Processing)`);
                }

                let batchRunId = null;
                try {
                    batchRunId = await startIngestionRun(registeredDocs.length);
                    context.log(`[${correlationId}] Initialized IngestionRun ID=${batchRunId} for ${registeredDocs.length} file(s).`);
                } catch (runErr) {
                    context.warn?.(`[${correlationId}] Notice: Failed to register IngestionRun: ${runErr.message}`);
                }

                // Fire-and-forget background worker pool using background-safe logger
                (async () => {
                    const batchLogger = createBackgroundLogger(correlationId);
                    let succeededCount = 0;
                    let failedCount = 0;
                    const errors = [];
                    let cursor = 0;
                    const poolSize = Math.min(CONCURRENCY_LIMIT, registeredDocs.length);

                    const workers = Array.from({ length: poolSize }, async () => {
                        while (cursor < registeredDocs.length) {
                            const doc = registeredDocs[cursor++];
                            const itemCorrId = `${correlationId}-${doc.documentId}`;
                            const docLogger = createBackgroundLogger(itemCorrId);
                            try {
                                docLogger.log(`[AsyncIngest] Starting ingestion for DocumentId=${doc.documentId} ("${doc.fileName}")...`);
                                await processDocumentIngestion({
                                    fileBuffer: doc.fileBuffer,
                                    fileName: doc.fileName,
                                    sourceType,
                                    authorityRank,
                                    allowedUserGroups,
                                    correlationId: itemCorrId,
                                    context: docLogger,
                                    documentKey,
                                    queueKey,
                                    fileLink,
                                    department,
                                    jobTitle,
                                    modifiedDate,
                                    modifiedByEmail,
                                    modifiedByName,
                                    existingRunId: batchRunId,
                                    manageRun: false,
                                    existingDocumentId: doc.documentId
                                });
                                succeededCount++;
                                if (batchRunId) {
                                    await updateIngestionRunProgress(batchRunId, true).catch(() => null);
                                }
                                docLogger.log(`[AsyncIngest] Ingestion completed for DocumentId=${doc.documentId}.`);
                            } catch (docErr) {
                                failedCount++;
                                errors.push(`${doc.fileName}: ${docErr.message}`);
                                if (batchRunId) {
                                    await updateIngestionRunProgress(batchRunId, false, `${doc.fileName}: ${docErr.message}`).catch(() => null);
                                }
                                docLogger.error(`[AsyncIngest] Ingestion failed for DocumentId=${doc.documentId}: ${docErr.message}`);
                            }
                        }
                    });

                    await Promise.all(workers);

                    if (batchRunId) {
                        const overallStatus = failedCount === 0 ? 'Succeeded' : (succeededCount === 0 ? 'Failed' : 'CompletedWithErrors');
                        const summary = errors.length > 0 ? errors.slice(0, 5).join(' | ') : null;
                        await completeIngestionRun(batchRunId, succeededCount, failedCount, overallStatus, summary).catch(() => null);
                    }
                    batchLogger.log(`[AsyncIngest] Batch finished. Succeeded=${succeededCount}, Failed=${failedCount}.`);
                })().catch(unhandled => {
                    const fallbackLogger = createBackgroundLogger(correlationId);
                    fallbackLogger.error(`[AsyncIngest] Unhandled background error: ${unhandled.message}`);
                });

                const firstDoc = registeredDocs[0];
                const responseBody = {
                    status: 'Accepted',
                    ingestionStatus: 'Processing',
                    documentId: firstDoc.documentId,
                    fileName: firstDoc.fileName,
                    documents: registeredDocs.map(d => ({
                        documentId: d.documentId,
                        fileName: d.fileName,
                        status: 'Processing'
                    })),
                    totalSubmitted: registeredDocs.length,
                    runId: batchRunId,
                    message: registeredDocs.length === 1
                        ? `Document "${firstDoc.fileName}" accepted for asynchronous ingestion. Use GET /api/getIngestionStatus?documentId=${firstDoc.documentId} to check status.`
                        : `${registeredDocs.length} documents accepted for asynchronous ingestion. Use GET /api/getIngestionStatus?documentId=<id> to check status.`,
                    statusUrl: `/api/getIngestionStatus?documentId=${firstDoc.documentId}`,
                    correlationId
                };

                return {
                    status: 202,
                    headers: {
                        'Content-Type': 'application/json',
                        'Location': `/api/getIngestionStatus?documentId=${firstDoc.documentId}`
                    },
                    body: JSON.stringify(responseBody)
                };
            }

            // -------------------------------------------------------------------------
            // SYNCHRONOUS INGESTION (ONLY WHEN ?async=false)
            // -------------------------------------------------------------------------
            context.log(`[${correlationId}] Running in synchronous mode (?async=false)...`);
            const syncResults = [];
            for (const item of filesToProcess) {
                const res = await processDocumentIngestion({
                    fileBuffer: item.fileBuffer,
                    fileName: item.fileName,
                    sourceType,
                    authorityRank,
                    allowedUserGroups,
                    correlationId,
                    context,
                    documentKey,
                    queueKey,
                    fileLink,
                    department,
                    jobTitle,
                    modifiedDate,
                    modifiedByEmail,
                    modifiedByName
                });
                syncResults.push(res);
            }

            if (syncResults.length === 1) {
                return {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(syncResults[0])
                };
            }

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    status: 'success',
                    documents: syncResults,
                    totalProcessed: syncResults.length,
                    correlationId
                })
            };

        } catch (err) {
            context.error(`[${correlationId}] !!! INGESTION FAILED !!!`);
            context.error(`[${correlationId}] Error Name: ${err.name || 'Error'}`);
            context.error(`[${correlationId}] Error Message: ${err.message}`);
            if (err.stack) {
                context.error(`[${correlationId}] Error Stack Trace: ${err.stack}`);
            }
            return toErrorResponse(err, correlationId);
        }
    }
});
