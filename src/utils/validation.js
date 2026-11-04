const { ValidationError } = require('./errors');

const MAX_DEFAULT_MB = 10;

function validateDocumentBuffer(buffer, fileName = '', maxMb = null) {
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new ValidationError('Uploaded file is empty or missing.');
    }

    const limitBytes = (maxMb || Number(process.env.MAX_UPLOAD_SIZE_MB) || MAX_DEFAULT_MB) * 1024 * 1024;
    if (buffer.length > limitBytes) {
        throw new ValidationError(`File size exceeds limit of ${limitBytes / (1024 * 1024)} MB.`);
    }

    const fn = (fileName || '').toLowerCase();
    const isPdf = buffer.length >= 4 && buffer.toString('utf8', 0, 4) === '%PDF';
    const isZipOrXlsx = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4B; // PK..
    const isOleOrXls = buffer.length >= 4 && buffer[0] === 0xD0 && buffer[1] === 0xCF; // OLE
    const isTextFormat = fn.endsWith('.txt') || fn.endsWith('.md') || fn.endsWith('.csv') || fn.endsWith('.json');
    const isTextBuffer = !buffer.includes(0);

    if (fn.endsWith('.xlsx') && !isZipOrXlsx && !isTextBuffer) {
        throw new ValidationError('Invalid Excel (.xlsx) file.');
    } else if (fn.endsWith('.xls') && !isOleOrXls && !isZipOrXlsx && !isTextBuffer) {
        throw new ValidationError('Invalid Excel (.xls) file.');
    } else if (fn.endsWith('.pdf') && !isPdf && !isTextBuffer) {
        throw new ValidationError('Invalid PDF file. Header does not match standard PDF specification.');
    } else if (!isPdf && !isZipOrXlsx && !isOleOrXls && !isTextFormat && !isTextBuffer) {
        throw new ValidationError('Unsupported file format. Please upload PDF, Excel (.xlsx, .xls), CSV, or direct text/markdown.');
    }

    return true;
}

/**
 * Validates documentId parameter for query endpoints
 */
function validateDocumentId(id) {
    if (id === undefined || id === null || id === '') {
        throw new ValidationError('Query parameter "documentId" is required. Example: ?documentId=5');
    }

    const parsed = Number(id);
    if (!isNaN(parsed) && parsed > 0) {
        return parsed;
    }

    if (typeof id === 'string' && id.trim()) {
        return id.trim();
    }

    throw new ValidationError('Parameter "documentId" must be a positive integer or valid filename string.');
}

function validateChatRequest(body) {
    if (!body || typeof body !== 'object') {
        throw new ValidationError('Request body must be a valid JSON object.');
    }

    const question = (body.question || '').trim();
    if (!question) {
        throw new ValidationError('Field "question" is required and cannot be empty.');
    }

    if (question.length > 2000) {
        throw new ValidationError('Question exceeds maximum allowed length of 2000 characters.');
    }

    let documentId = null;
    if (body.documentId !== undefined && body.documentId !== null && body.documentId !== '') {
        const parsed = Number(body.documentId);
        if (!isNaN(parsed) && parsed > 0) {
            documentId = parsed;
        } else if (typeof body.documentId === 'string' && body.documentId.trim()) {
            documentId = body.documentId.trim();
        } else {
            throw new ValidationError('Field "documentId" must be a positive number or valid identifier string.');
        }
    }

    return { question, documentId };
}

module.exports = {
    validateDocumentBuffer,
    validateDocumentId,
    validateChatRequest
};
