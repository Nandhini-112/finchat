const { ValidationError } = require('./errors');
const { normalizeEmail } = require('./authority-normalizer');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates employee details for creation or update.
 * 
 * @param {object} data - Employee data object
 * @param {boolean} isUpdate - Whether this is an update operation (fields optional)
 * @throws {ValidationError} if any validation rule is violated
 * @returns {boolean} true if valid
 */
function validateEmployeeDetails(data, isUpdate = false) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ValidationError('Employee data must be a valid JSON object.');
    }

    // Name validation
    if (!isUpdate || data.employeeName !== undefined) {
        if (!data.employeeName || typeof data.employeeName !== 'string' || !data.employeeName.trim()) {
            throw new ValidationError('Employee name is required and cannot be empty.');
        }
        if (data.employeeName.trim().length > 150) {
            throw new ValidationError('Employee name cannot exceed 150 characters.');
        }
    }

    // Email validation
    if (!isUpdate || data.email !== undefined) {
        if (!data.email || typeof data.email !== 'string' || !data.email.trim()) {
            throw new ValidationError('Employee email is required and cannot be empty.');
        }
        const normalized = normalizeEmail(data.email);
        if (!normalized || !EMAIL_REGEX.test(normalized) || normalized.length > 255) {
            throw new ValidationError(`Invalid email format: "${data.email}".`);
        }
    }

    // Job Title validation (optional in Phase 1)
    if (data.jobTitle !== undefined && data.jobTitle !== null) {
        if (typeof data.jobTitle !== 'string') {
            throw new ValidationError('Job title must be a string.');
        }
        if (data.jobTitle.trim().length > 150) {
            throw new ValidationError('Job title cannot exceed 150 characters.');
        }
    }

    // Department validation (optional in Phase 1)
    if (data.department !== undefined && data.department !== null) {
        if (typeof data.department !== 'string') {
            throw new ValidationError('Department must be a string.');
        }
        if (data.department.trim().length > 100) {
            throw new ValidationError('Department cannot exceed 100 characters.');
        }
    }

    // EntraObjectId validation (optional)
    if (data.entraObjectId !== undefined && data.entraObjectId !== null) {
        if (typeof data.entraObjectId !== 'string' || data.entraObjectId.trim().length > 255) {
            throw new ValidationError('EntraObjectId must be a string up to 255 characters.');
        }
    }

    // AuthorityRankId validation (optional)
    if (data.authorityRankId !== undefined && data.authorityRankId !== null) {
        const rankId = Number(data.authorityRankId);
        if (!Number.isInteger(rankId) || rankId <= 0) {
            throw new ValidationError('AuthorityRankId must be a positive integer.');
        }
    }

    // IsActive validation (optional)
    if (data.isActive !== undefined && typeof data.isActive !== 'boolean') {
        throw new ValidationError('IsActive must be a boolean.');
    }

    return true;
}

/**
 * Validates authority mapping details for dbo.AuthorityRank records.
 * 
 * @param {object} data - Authority mapping data object
 * @throws {ValidationError} if any validation rule is violated
 * @returns {boolean} true if valid
 */
function validateAuthorityMapping(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new ValidationError('Authority mapping data must be a valid JSON object.');
    }

    if (!data.jobTitle || typeof data.jobTitle !== 'string' || !data.jobTitle.trim()) {
        throw new ValidationError('Job title is required for authority mapping.');
    }
    if (data.jobTitle.trim().length > 150) {
        throw new ValidationError('Job title cannot exceed 150 characters.');
    }

    if (!data.department || typeof data.department !== 'string' || !data.department.trim()) {
        throw new ValidationError('Department is required for authority mapping.');
    }
    if (data.department.trim().length > 100) {
        throw new ValidationError('Department cannot exceed 100 characters.');
    }

    const rank = Number(data.authorityRank);
    if (!Number.isInteger(rank) || rank < 1 || rank > 5) {
        throw new ValidationError('Authority rank must be an integer between 1 (entry-level) and 5 (highest authority).');
    }

    if (data.authorityLevel !== undefined && data.authorityLevel !== null) {
        if (typeof data.authorityLevel !== 'string' || data.authorityLevel.trim().length > 50) {
            throw new ValidationError('Authority level must be a string up to 50 characters.');
        }
    }

    if (data.isActive !== undefined && typeof data.isActive !== 'boolean') {
        throw new ValidationError('IsActive must be a boolean.');
    }

    return true;
}

module.exports = {
    validateEmployeeDetails,
    validateAuthorityMapping
};

