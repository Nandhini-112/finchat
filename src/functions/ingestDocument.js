const { app } = require('@azure/functions');
const { validateDocumentBuffer } = require('../utils/validation');
const { ValidationError, toErrorResponse } = require('../utils/errors');
const { processDocumentIngestion } = require('../services/ingestion-pipeline');
const { blankToNull } = require('../services/search-document');

function firstText(...values) {
    for (const value of values) {
        const text = blankToNull(value);
        if (text) return text;
    }
    return null;
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
            let fileBuffer;

            // 1. Extract filename from query string (case-insensitive)
            let fileName = null;
            if (request.query) {
                for (const [key, val] of request.query.entries()) {
                    if (/^(filename|name|file|title)$/i.test(key) && val) {
                        fileName = decodeURIComponent(val).trim();
                        break;
                    }
                }
            }

            // 2. Check headers (x-filename, x-file-name, content-disposition)
            if (!fileName) {
                const xFn = request.headers.get('x-filename') || request.headers.get('x-file-name');
                if (xFn) fileName = decodeURIComponent(xFn).trim();
            }

            if (!fileName) {
                const disp = request.headers.get('content-disposition') || '';
                const match = disp.match(/filename\*?=['"]?(?:UTF-\d['"]*)?([^;\r\n"']*)['"]?/i);
                if (match && match[1]) fileName = decodeURIComponent(match[1]).trim();
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

            if (contentType.includes('text/plain') || contentType.includes('text/markdown') || contentType.includes('text/csv')) {
                const textContent = await request.text();
                fileBuffer = Buffer.from(textContent, 'utf8');
                fileName = fileName || `report_${Date.now()}.${contentType.includes('csv') ? 'csv' : 'txt'}`;
            } else if (contentType.includes('application/pdf') ||
                contentType.includes('application/octet-stream') ||
                contentType.includes('spreadsheetml') ||
                contentType.includes('ms-excel')) {
                const arrayBuffer = await request.arrayBuffer();
                fileBuffer = Buffer.from(arrayBuffer);
            } else if (contentType.includes('multipart/form-data')) {
                const formData = await request.formData();
                const file = formData.get('file') || formData.get('document');
                if (file && typeof file.arrayBuffer === 'function') {
                    const arrayBuffer = await file.arrayBuffer();
                    fileBuffer = Buffer.from(arrayBuffer);
                    fileName = fileName || file.name;
                } else {
                    throw new ValidationError('form-data request must include a "file" or "document" field with an uploaded file.');
                }
                if (formData.get('fileName')) fileName = formData.get('fileName');
                if (formData.get('allowedUserGroups')) allowedUserGroups = formData.get('allowedUserGroups');
                if (formData.get('authorityRank')) authorityRank = Number(formData.get('authorityRank'));
                if (formData.get('sourceType')) sourceType = formData.get('sourceType');
                documentKey = firstText(formData.get('documentKey'), documentKey);
                queueKey = firstText(formData.get('queueKey'), queueKey);
                fileLink = firstText(formData.get('fileLink'), fileLink);
                department = firstText(formData.get('department'), department);
                jobTitle = firstText(formData.get('jobTitle'), jobTitle);
                modifiedDate = firstText(formData.get('modifiedDate'), modifiedDate);
            } else if (contentType.includes('application/json')) {
                const jsonBody = await request.json().catch(() => null);
                if (!jsonBody) throw new ValidationError('JSON body is malformed or empty.');

                fileName = fileName || jsonBody.fileName || jsonBody.filename;
                allowedUserGroups = allowedUserGroups || jsonBody.allowedUserGroups || null;
                if (jsonBody.authorityRank) authorityRank = Number(jsonBody.authorityRank);
                if (jsonBody.sourceType) sourceType = jsonBody.sourceType;
                documentKey = firstText(jsonBody.documentKey, documentKey);
                queueKey = firstText(jsonBody.queueKey, queueKey);
                fileLink = firstText(jsonBody.fileLink, fileLink);
                department = firstText(jsonBody.department, department);
                jobTitle = firstText(jsonBody.jobTitle, jobTitle);
                modifiedDate = firstText(jsonBody.modifiedDate, modifiedDate);

                if (jsonBody.text || jsonBody.content) {
                    fileBuffer = Buffer.from(jsonBody.text || jsonBody.content, 'utf8');
                    fileName = fileName || `report_${Date.now()}.txt`;
                } else if (jsonBody.base64) {
                    fileBuffer = Buffer.from(jsonBody.base64, 'base64');
                } else {
                    throw new ValidationError('JSON request must include "text", "content", or "base64".');
                }
            } else {
                throw new ValidationError(`Unsupported Content-Type: "${contentType}". Finora AI accepts form-data, PDF/Binary, CSV, Excel (.xlsx/.xls), Text, or JSON.`);
            }

            // Auto-detect format and append extension if missing
            const isPdf = fileBuffer && fileBuffer.length >= 4 && fileBuffer.toString('utf8', 0, 4) === '%PDF';
            const isZipOrExcel = fileBuffer && fileBuffer.length >= 4 && fileBuffer.toString('hex', 0, 4) === '504b0304';

            if (fileName) {
                if (!fileName.includes('.')) {
                    if (isPdf) fileName += '.pdf';
                    else if (isZipOrExcel) fileName += '.xlsx';
                    else if (contentType.includes('csv')) fileName += '.csv';
                    else fileName += '.txt';
                }
            } else {
                const timestamp = Date.now();
                if (isPdf) fileName = `document_${timestamp}.pdf`;
                else if (isZipOrExcel) fileName = `spreadsheet_${timestamp}.xlsx`;
                else if (contentType.includes('csv')) fileName = `data_${timestamp}.csv`;
                else fileName = `document_${timestamp}.txt`;
            }

            validateDocumentBuffer(fileBuffer, fileName);

            context.log(`[${correlationId}] Step 1 Output: Buffer validated successfully.`);
            context.log(`[${correlationId}]   - Resolved FileName: "${fileName}"`);
            context.log(`[${correlationId}]   - File Size: ${fileBuffer.length} bytes (${(fileBuffer.length / 1024).toFixed(1)} KB)`);
            context.log(`[${correlationId}]   - Authority Rank: ${authorityRank}`);
            context.log(`[${correlationId}]   - Source Type: "${sourceType}"`);
            context.log(`[${correlationId}]   - Content-Type: "${contentType}"`);

            const result = await processDocumentIngestion({
                fileBuffer,
                fileName,
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
                modifiedDate
            });

            return {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(result)
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
