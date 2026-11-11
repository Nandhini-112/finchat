
const { ValidationError } = require('./errors');
const path = require('path');
const { extractFromPdf } = require('../services/local-extractor');
const MAX_DEFAULT_MB = 10;

const ALLOWED_EXTENSIONS = ['.pdf', '.xls', '.xlsx'];

async function validateDocumentBuffer(buffer, fileName = '', maxMb = null) {

    // 1. Validate empty or missing document
    if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        throw new ValidationError(
            'The uploaded document is empty. Please upload a valid document.'
        );
    }

    // 2. Validate file size
    const configuredLimit =
        maxMb ?? Number(process.env.MAX_UPLOAD_SIZE_MB);

    const maxSizeMB =
        Number.isFinite(configuredLimit) && configuredLimit > 0
            ? configuredLimit
            : MAX_DEFAULT_MB;

    const limitBytes = maxSizeMB * 1024 * 1024;

    if (buffer.length > limitBytes) {
        throw new ValidationError(
            `File size exceeds the maximum allowed limit of ${maxSizeMB} MB.`
        );
    }

    // 3. Strict file extension validation
    const extension = path.extname(fileName).toLowerCase();

    if (!ALLOWED_EXTENSIONS.includes(extension)) {
        throw new ValidationError(
            'Unsupported file format. Only PDF (.pdf), Excel (.xls), and Excel (.xlsx) files are accepted.'
        );
    }

    // 4. Detect actual file format using file signatures
    const isPdf =
        buffer.length >= 5 &&
        buffer.toString('ascii', 0, 5) === '%PDF-';

    const isXlsx =
        buffer.length >= 4 &&
        buffer[0] === 0x50 &&
        buffer[1] === 0x4B &&
        buffer[2] === 0x03 &&
        buffer[3] === 0x04;

    const isXls =
        buffer.length >= 8 &&
        buffer.subarray(0, 8).equals(
            Buffer.from([
                0xD0, 0xCF, 0x11, 0xE0,
                0xA1, 0xB1, 0x1A, 0xE1
            ])
        );

    // 5. Match extension with actual file content
    if (extension === '.pdf' && !isPdf) {
        throw new ValidationError(
            'Invalid PDF file. File content does not match PDF format.'
        );
    }

    if (extension === '.xlsx' && !isXlsx) {
        throw new ValidationError(
            'Invalid Excel (.xlsx) file. File content does not match XLSX format.'
        );
    }

    if (extension === '.xls' && !isXls) {
        throw new ValidationError(
            'Invalid Excel (.xls) file. File content does not match XLS format.'
        );
    }

    // 6. Basic detection of encrypted/password-protected PDFs
    if (isPdf && buffer.includes(Buffer.from('/Encrypt'))) {
        throw new ValidationError(
            'The uploaded document is password-protected. Please upload an unprotected document.'
        );
    }
    // 7. Validate actual PDF content
    if (extension === '.pdf') {
        let pdfData;

        try {
            pdfData = await extractFromPdf(buffer);
        } catch (err) {
            throw new ValidationError(
                'Invalid or corrupted PDF. Please upload a valid PDF.'
            );
        }

        const extractedText = (pdfData.pages || [])
            .map(page => page.text || '')
            .join('')
            .trim();

        if (!pdfData.pages?.length || !extractedText) {
            throw new ValidationError(
                'Empty PDF detected. Please upload a PDF containing readable content.'
            );
        }
    }

    return true;
}


/**
 * Validates documentId parameter for query endpoints
 */
function validateDocumentId(id) {

    if (id === undefined || id === null || id === '') {
        throw new ValidationError(
            'Query parameter "documentId" is required. Example: ?documentId=5'
        );
    }

    const parsed = Number(id);

    if (!isNaN(parsed) && parsed > 0) {
        return parsed;
    }

    if (typeof id === 'string' && id.trim()) {
        return id.trim();
    }

    throw new ValidationError(
        'Parameter "documentId" must be a positive integer or valid filename string.'
    );
}


/**
 * Validates chat request body
 */
function validateChatRequest(body) {

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new ValidationError(
            'Request body must be a valid JSON object.'
        );
    }

    const question =
        typeof body.question === 'string'
            ? body.question.trim()
            : '';

    if (!question) {
        throw new ValidationError(
            'Field "question" is required and cannot be empty.'
        );
    }

    if (question.length > 2000) {
        throw new ValidationError(
            'Question exceeds maximum allowed length of 2000 characters.'
        );
    }

    let documentId = null;

    if (
        body.documentId !== undefined &&
        body.documentId !== null &&
        body.documentId !== ''
    ) {
        const parsed = Number(body.documentId);

        if (!isNaN(parsed) && parsed > 0) {
            documentId = parsed;
        } else if (
            typeof body.documentId === 'string' &&
            body.documentId.trim()
        ) {
            documentId = body.documentId.trim();
        } else {
            throw new ValidationError(
                'Field "documentId" must be a positive number or valid identifier string.'
            );
        }
    }

    return { question, documentId };
}


module.exports = {
    validateDocumentBuffer,
    validateDocumentId,
    validateChatRequest
};
