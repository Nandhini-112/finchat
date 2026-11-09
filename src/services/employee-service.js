require('../utils/config');
const sql = require('mssql');
const { getPool } = require('./sql');
const { normalizeEmail, normalizeJobTitle, normalizeDepartment } = require('../utils/authority-normalizer');
const { validateEmployeeDetails } = require('../utils/authority-validation');
const { getAuthorityByJobTitleAndDepartment } = require('./authority-ranking');
const { ValidationError, NotFoundError, AppError } = require('../utils/errors');

/**
 * Employee Management Service
 * Finora Azure AI - Employee Authority Ranking Module (Phase 1)
 * 
 * Manages employee records in dbo.EmployeeDetails and links them
 * to deterministic authority ranks from dbo.AuthorityRank.
 * 
 * Guarantees:
 * - Uses existing SQL connection pool.
 * - Uses parameterized SQL queries exclusively.
 * - Strictly rejects duplicate normalized emails.
 * - Leaves AuthorityRankId as NULL when Job Title or Department is missing.
 * - Updates UpdatedAt on every modification.
 */

/**
 * Creates a new employee record.
 * 
 * @param {object} employeeData - Employee details
 * @returns {Promise<object>} Created employee details
 */
async function createEmployee(employeeData) {
    validateEmployeeDetails(employeeData, false);

    const pool = await getPool();
    const normEmail = normalizeEmail(employeeData.email);

    // 1. Check for duplicate normalized email
    const existing = await pool.request()
        .input('NormEmail', sql.NVarChar(255), normEmail)
        .query(`SELECT EmployeeId FROM dbo.EmployeeDetails WHERE NormalizedEmail = @NormEmail`);

    if (existing.recordset.length > 0) {
        throw new ValidationError(`An employee with email "${employeeData.email}" already exists.`);
    }

    // 2. Resolve Job Title, Department, and AuthorityRankId
    let resolvedAuthorityRankId = null;
    let normJobTitle = null;
    let normDept = null;
    const rawJobTitle = employeeData.jobTitle ? employeeData.jobTitle.trim() : null;
    const rawDept = employeeData.department ? employeeData.department.trim() : null;

    if (rawJobTitle) normJobTitle = normalizeJobTitle(rawJobTitle);
    if (rawDept) normDept = normalizeDepartment(rawDept);

    if (employeeData.authorityRankId) {
        // Validate explicit authority rank ID
        const rankCheck = await pool.request()
            .input('RankId', sql.Int, Number(employeeData.authorityRankId))
            .query(`SELECT Id, IsActive FROM dbo.AuthorityRank WHERE Id = @RankId`);

        if (rankCheck.recordset.length === 0) {
            throw new ValidationError(`AuthorityRank mapping ID ${employeeData.authorityRankId} does not exist.`);
        }
        if (!rankCheck.recordset[0].IsActive) {
            throw new ValidationError(`AuthorityRank mapping ID ${employeeData.authorityRankId} is currently inactive.`);
        }
        resolvedAuthorityRankId = Number(employeeData.authorityRankId);
    } else if (rawJobTitle && rawDept) {
        // Look up deterministic authority rank
        const lookup = await getAuthorityByJobTitleAndDepartment(rawJobTitle, rawDept);
        if (lookup.status === 'FOUND') {
            resolvedAuthorityRankId = lookup.authorityRankId;
        }
    }

    // 3. Insert employee record
    const insertResult = await pool.request()
        .input('EmployeeName', sql.NVarChar(150), employeeData.employeeName.trim())
        .input('Email', sql.NVarChar(255), employeeData.email.trim())
        .input('NormalizedEmail', sql.NVarChar(255), normEmail)
        .input('EntraObjectId', sql.NVarChar(255), employeeData.entraObjectId ? employeeData.entraObjectId.trim() : null)
        .input('JobTitle', sql.NVarChar(150), rawJobTitle)
        .input('NormalizedJobTitle', sql.NVarChar(150), normJobTitle)
        .input('Department', sql.NVarChar(100), rawDept)
        .input('NormalizedDepartment', sql.NVarChar(100), normDept)
        .input('AuthorityRankId', sql.Int, resolvedAuthorityRankId)
        .input('IsActive', sql.Bit, employeeData.isActive !== undefined ? (employeeData.isActive ? 1 : 0) : 1)
        .query(`
            INSERT INTO dbo.EmployeeDetails 
                (EmployeeName, Email, NormalizedEmail, EntraObjectId, JobTitle, NormalizedJobTitle,
                 Department, NormalizedDepartment, AuthorityRankId, IsActive, CreatedAt)
            OUTPUT 
                INSERTED.EmployeeId,
                INSERTED.EmployeeName,
                INSERTED.Email,
                INSERTED.NormalizedEmail,
                INSERTED.EntraObjectId,
                INSERTED.JobTitle,
                INSERTED.Department,
                INSERTED.AuthorityRankId,
                INSERTED.IsActive,
                INSERTED.CreatedAt
            VALUES 
                (@EmployeeName, @Email, @NormalizedEmail, @EntraObjectId, @JobTitle, @NormalizedJobTitle,
                 (@Department), @NormalizedDepartment, @AuthorityRankId, @IsActive, SYSUTCDATETIME())
        `);

    const created = insertResult.recordset[0];
    return {
        employeeId: created.EmployeeId,
        employeeName: created.EmployeeName,
        email: created.Email,
        entraObjectId: created.EntraObjectId,
        jobTitle: created.JobTitle,
        department: created.Department,
        authorityRankId: created.AuthorityRankId,
        isActive: Boolean(created.IsActive),
        createdAt: created.CreatedAt
    };
}

/**
 * Updates an existing employee record.
 * 
 * @param {number} employeeId - Numeric employee ID
 * @param {object} updateData - Fields to update
 * @returns {Promise<object>} Updated employee details
 */
async function updateEmployee(employeeId, updateData) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('A valid numeric EmployeeId is required.');
    }
    validateEmployeeDetails(updateData, true);

    const pool = await getPool();

    // 1. Check that employee exists
    const existingResult = await pool.request()
        .input('EmployeeId', sql.Int, id)
        .query(`SELECT * FROM dbo.EmployeeDetails WHERE EmployeeId = @EmployeeId`);

    if (existingResult.recordset.length === 0) {
        throw new NotFoundError(`Employee with ID ${id} was not found.`);
    }

    const current = existingResult.recordset[0];

    // 2. Email uniqueness check if changing email
    let newNormEmail = current.NormalizedEmail;
    let newEmail = current.Email;
    if (updateData.email && updateData.email.trim()) {
        newNormEmail = normalizeEmail(updateData.email);
        newEmail = updateData.email.trim();
        if (newNormEmail !== current.NormalizedEmail) {
            const dupCheck = await pool.request()
                .input('NormEmail', sql.NVarChar(255), newNormEmail)
                .input('EmployeeId', sql.Int, id)
                .query(`SELECT EmployeeId FROM dbo.EmployeeDetails WHERE NormalizedEmail = @NormEmail AND EmployeeId <> @EmployeeId`);

            if (dupCheck.recordset.length > 0) {
                throw new ValidationError(`Another employee with email "${updateData.email}" already exists.`);
            }
        }
    }

    // 3. Resolve Job Title & Department
    const newJobTitle = updateData.jobTitle !== undefined 
        ? (updateData.jobTitle ? updateData.jobTitle.trim() : null)
        : current.JobTitle;
    const newNormJobTitle = newJobTitle ? normalizeJobTitle(newJobTitle) : null;

    const newDept = updateData.department !== undefined 
        ? (updateData.department ? updateData.department.trim() : null)
        : current.Department;
    const newNormDept = newDept ? normalizeDepartment(newDept) : null;

    // 4. Resolve AuthorityRankId
    let newAuthorityRankId = current.AuthorityRankId;

    if (updateData.authorityRankId !== undefined) {
        if (updateData.authorityRankId === null) {
            newAuthorityRankId = null;
        } else {
            const rankCheck = await pool.request()
                .input('RankId', sql.Int, Number(updateData.authorityRankId))
                .query(`SELECT Id, IsActive FROM dbo.AuthorityRank WHERE Id = @RankId`);

            if (rankCheck.recordset.length === 0) {
                throw new ValidationError(`AuthorityRank mapping ID ${updateData.authorityRankId} does not exist.`);
            }
            if (!rankCheck.recordset[0].IsActive) {
                throw new ValidationError(`AuthorityRank mapping ID ${updateData.authorityRankId} is currently inactive.`);
            }
            newAuthorityRankId = Number(updateData.authorityRankId);
        }
    } else if (updateData.jobTitle !== undefined || updateData.department !== undefined) {
        // Re-evaluate authority mapping if title or dept changed
        if (newJobTitle && newDept) {
            const lookup = await getAuthorityByJobTitleAndDepartment(newJobTitle, newDept);
            newAuthorityRankId = lookup.status === 'FOUND' ? lookup.authorityRankId : null;
        } else {
            newAuthorityRankId = null;
        }
    }

    const newName = updateData.employeeName !== undefined ? updateData.employeeName.trim() : current.EmployeeName;
    const newEntraId = updateData.entraObjectId !== undefined 
        ? (updateData.entraObjectId ? updateData.entraObjectId.trim() : null) 
        : current.EntraObjectId;
    const newIsActive = updateData.isActive !== undefined ? (updateData.isActive ? 1 : 0) : current.IsActive;

    // 5. Update record
    const updateResult = await pool.request()
        .input('EmployeeId', sql.Int, id)
        .input('EmployeeName', sql.NVarChar(150), newName)
        .input('Email', sql.NVarChar(255), newEmail)
        .input('NormalizedEmail', sql.NVarChar(255), newNormEmail)
        .input('EntraObjectId', sql.NVarChar(255), newEntraId)
        .input('JobTitle', sql.NVarChar(150), newJobTitle)
        .input('NormalizedJobTitle', sql.NVarChar(150), newNormJobTitle)
        .input('Department', sql.NVarChar(100), newDept)
        .input('NormalizedDepartment', sql.NVarChar(100), newNormDept)
        .input('AuthorityRankId', sql.Int, newAuthorityRankId)
        .input('IsActive', sql.Bit, newIsActive)
        .query(`
            UPDATE dbo.EmployeeDetails
            SET EmployeeName = @EmployeeName,
                Email = @Email,
                NormalizedEmail = @NormalizedEmail,
                EntraObjectId = @EntraObjectId,
                JobTitle = @JobTitle,
                NormalizedJobTitle = @NormalizedJobTitle,
                Department = @Department,
                NormalizedDepartment = @NormalizedDepartment,
                AuthorityRankId = @AuthorityRankId,
                IsActive = @IsActive,
                UpdatedAt = SYSUTCDATETIME()
            OUTPUT 
                INSERTED.EmployeeId,
                INSERTED.EmployeeName,
                INSERTED.Email,
                INSERTED.EntraObjectId,
                INSERTED.JobTitle,
                INSERTED.Department,
                INSERTED.AuthorityRankId,
                INSERTED.IsActive,
                INSERTED.CreatedAt,
                INSERTED.UpdatedAt
            WHERE EmployeeId = @EmployeeId
        `);

    const updated = updateResult.recordset[0];
    return {
        employeeId: updated.EmployeeId,
        employeeName: updated.EmployeeName,
        email: updated.Email,
        entraObjectId: updated.EntraObjectId,
        jobTitle: updated.JobTitle,
        department: updated.Department,
        authorityRankId: updated.AuthorityRankId,
        isActive: Boolean(updated.IsActive),
        createdAt: updated.CreatedAt,
        updatedAt: updated.UpdatedAt
    };
}

/**
 * Looks up an employee by normalized email.
 * 
 * @param {string} email - Email address
 * @returns {Promise<object|null>} Employee details with authority mapping or null
 */
async function getEmployeeByEmail(email) {
    const normEmail = normalizeEmail(email);
    if (!normEmail) {
        throw new ValidationError('A valid email address is required.');
    }

    const pool = await getPool();
    const result = await pool.request()
        .input('NormEmail', sql.NVarChar(255), normEmail)
        .query(`
            SELECT 
                e.EmployeeId,
                e.EmployeeName,
                e.Email,
                e.EntraObjectId,
                e.JobTitle,
                e.Department,
                e.AuthorityRankId,
                e.IsActive,
                e.CreatedAt,
                e.UpdatedAt,
                a.AuthorityRank,
                a.AuthorityLevel,
                a.IsActive AS AuthorityMappingIsActive
            FROM dbo.EmployeeDetails e
            LEFT JOIN dbo.AuthorityRank a ON e.AuthorityRankId = a.Id
            WHERE e.NormalizedEmail = @NormEmail
        `);

    if (result.recordset.length === 0) {
        return null;
    }

    const row = result.recordset[0];
    return {
        employeeId: row.EmployeeId,
        employeeName: row.EmployeeName,
        email: row.Email,
        entraObjectId: row.EntraObjectId,
        jobTitle: row.JobTitle,
        department: row.Department,
        authorityRankId: row.AuthorityRankId,
        authorityRank: row.AuthorityRank || null,
        authorityLevel: row.AuthorityLevel || null,
        isActive: Boolean(row.IsActive),
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    };
}

/**
 * Looks up an employee by numeric ID.
 * 
 * @param {number} employeeId - Employee ID
 * @returns {Promise<object|null>} Employee details with authority mapping or null
 */
async function getEmployeeById(employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('A valid numeric EmployeeId is required.');
    }

    const pool = await getPool();
    const result = await pool.request()
        .input('EmployeeId', sql.Int, id)
        .query(`
            SELECT 
                e.EmployeeId,
                e.EmployeeName,
                e.Email,
                e.EntraObjectId,
                e.JobTitle,
                e.Department,
                e.AuthorityRankId,
                e.IsActive,
                e.CreatedAt,
                e.UpdatedAt,
                a.AuthorityRank,
                a.AuthorityLevel,
                a.IsActive AS AuthorityMappingIsActive
            FROM dbo.EmployeeDetails e
            LEFT JOIN dbo.AuthorityRank a ON e.AuthorityRankId = a.Id
            WHERE e.EmployeeId = @EmployeeId
        `);

    if (result.recordset.length === 0) {
        return null;
    }

    const row = result.recordset[0];
    return {
        employeeId: row.EmployeeId,
        employeeName: row.EmployeeName,
        email: row.Email,
        entraObjectId: row.EntraObjectId,
        jobTitle: row.JobTitle,
        department: row.Department,
        authorityRankId: row.AuthorityRankId,
        authorityRank: row.AuthorityRank || null,
        authorityLevel: row.AuthorityLevel || null,
        isActive: Boolean(row.IsActive),
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    };
}

/**
 * Retrieves all employees with optional filters.
 * 
 * @param {object} [filters={}] - Optional filters (department, isActive, authorityRank)
 * @returns {Promise<Array>} List of employees
 */
async function getAllEmployees(filters = {}) {
    const pool = await getPool();
    const req = pool.request();
    const conditions = [];

    if (filters.department) {
        req.input('NormDept', sql.NVarChar(100), normalizeDepartment(filters.department));
        conditions.push(`e.NormalizedDepartment = @NormDept`);
    }

    if (filters.isActive !== undefined && filters.isActive !== null) {
        req.input('IsActive', sql.Bit, filters.isActive ? 1 : 0);
        conditions.push(`e.IsActive = @IsActive`);
    }

    if (filters.authorityRank !== undefined && filters.authorityRank !== null) {
        req.input('Rank', sql.Int, Number(filters.authorityRank));
        conditions.push(`a.AuthorityRank = @Rank`);
    }

    let query = `
        SELECT 
            e.EmployeeId,
            e.EmployeeName,
            e.Email,
            e.EntraObjectId,
            e.JobTitle,
            e.Department,
            e.AuthorityRankId,
            e.IsActive,
            e.CreatedAt,
            e.UpdatedAt,
            a.AuthorityRank,
            a.AuthorityLevel
        FROM dbo.EmployeeDetails e
        LEFT JOIN dbo.AuthorityRank a ON e.AuthorityRankId = a.Id
    `;

    if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY e.EmployeeId ASC`;

    const result = await req.query(query);
    return result.recordset.map(row => ({
        employeeId: row.EmployeeId,
        employeeName: row.EmployeeName,
        email: row.Email,
        entraObjectId: row.EntraObjectId,
        jobTitle: row.JobTitle,
        department: row.Department,
        authorityRankId: row.AuthorityRankId,
        authorityRank: row.AuthorityRank || null,
        authorityLevel: row.AuthorityLevel || null,
        isActive: Boolean(row.IsActive),
        createdAt: row.CreatedAt,
        updatedAt: row.UpdatedAt
    }));
}

/**
 * Deactivates an employee by setting IsActive = 0.
 * 
 * @param {number} employeeId - Employee ID
 * @returns {Promise<object>} Deactivated employee details
 */
async function deactivateEmployee(employeeId) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('A valid numeric EmployeeId is required.');
    }

    const pool = await getPool();
    const result = await pool.request()
        .input('EmployeeId', sql.Int, id)
        .query(`
            UPDATE dbo.EmployeeDetails
            SET IsActive = 0,
                UpdatedAt = SYSUTCDATETIME()
            OUTPUT 
                INSERTED.EmployeeId,
                INSERTED.EmployeeName,
                INSERTED.Email,
                INSERTED.IsActive,
                INSERTED.UpdatedAt
            WHERE EmployeeId = @EmployeeId
        `);

    if (result.recordset.length === 0) {
        throw new NotFoundError(`Employee with ID ${id} was not found.`);
    }

    const row = result.recordset[0];
    return {
        employeeId: row.EmployeeId,
        employeeName: row.EmployeeName,
        email: row.Email,
        isActive: Boolean(row.IsActive),
        updatedAt: row.UpdatedAt
    };
}

module.exports = {
    createEmployee,
    updateEmployee,
    getEmployeeByEmail,
    getEmployeeById,
    getAllEmployees,
    deactivateEmployee
};

