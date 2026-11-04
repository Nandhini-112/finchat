class AppError extends Error {
    constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
        super(message);
        this.name = this.constructor.name;
        this.statusCode = statusCode;
        this.code = code;
        this.details = details;
        Error.captureStackTrace(this, this.constructor);
    }
}

class ValidationError extends AppError {
    constructor(message, details = null) {
        super(message, 400, 'VALIDATION_ERROR', details);
    }
}

class NotFoundError extends AppError {
    constructor(message = 'Resource not found', details = null) {
        super(message, 404, 'NOT_FOUND', details);
    }
}

function sanitizeErrorMessage(err) {
    if (!err) return 'An unexpected error occurred.';
    let message = err.message || String(err);
    // Redact potential connection strings or secret patterns
    message = message.replace(/password=[^;]*/gi, 'password=***');
    message = message.replace(/key=[^;]*/gi, 'key=***');
    return message;
}

function toErrorResponse(err, correlationId = null) {
    const statusCode = err.statusCode || 500;
    const code = err.code || 'INTERNAL_ERROR';
    const message = sanitizeErrorMessage(err);

    return {
        status: statusCode,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            status: 'error',
            code,
            message,
            correlationId
        })
    };
}

module.exports = {
    AppError,
    ValidationError,
    NotFoundError,
    sanitizeErrorMessage,
    toErrorResponse
};
