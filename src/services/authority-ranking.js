require('../utils/config');
const sql = require('mssql');
const { getPool } = require('./sql');
const { normalizeJobTitle, normalizeDepartment, normalizeEmail } = require('../utils/authority-normalizer');
const { ValidationError, NotFoundError } = require('../utils/errors');

/**
 * Authority Ranking Service
 * Finora Azure AI - Employee Authority Ranking Module (Phase 1)
 * 
 * Provides deterministic database lookup of employee authority ranks
 * based on normalized Job Title and Department matching against dbo.AuthorityRank.
 * 
 * Guarantees:
 * - Uses existing SQL connection pool.
 * - Uses parameterized SQL queries exclusively.
 * - Never guesses a rank using an LLM or fuzzy matching.
 * - Returns clear, structured status codes when mappings are not found.
 */

/**
 * Looks up an active authority mapping by Job Title and Department.
 * 
 * @param {string} jobTitle - Employee job title
 * @param {string} department - Employee department
 * @returns {Promise<object>} Authority rank details or NOT_FOUND status object
 */
async function getAuthorityByJobTitleAndDepartment(jobTitle, department) {
    const normJobTitle = normalizeJobTitle(jobTitle);
    const normDept = normalizeDepartment(department);

    if (!normJobTitle || !normDept) {
        return {
            status: 'AUTHORITY_MAPPING_NOT_FOUND',
            authorityRank: null,
            authorityLevel: null,
            authorityRankId: null,
            reason: 'Job Title and Department are both required for authority lookup.'
        };
    }

    const pool = await getPool();
    const result = await pool.request()
        .input('NormJobTitle', sql.NVarChar(150), normJobTitle)
        .input('NormDept', sql.NVarChar(100), normDept)
        .query(`
            SELECT TOP 1
                Id,
                JobTitle,
                NormalizedJobTitle,
                Department,
                NormalizedDepartment,
                AuthorityRank,
                AuthorityLevel,
                IsActive
            FROM dbo.AuthorityRank
            WHERE NormalizedJobTitle = @NormJobTitle
              AND NormalizedDepartment = @NormDept
              AND IsActive = 1
            ORDER BY AuthorityRank DESC, Id ASC
        `);

    if (result.recordset.length === 0) {
        return {
            status: 'AUTHORITY_MAPPING_NOT_FOUND',
            authorityRank: null,
            authorityLevel: null,
            authorityRankId: null,
            jobTitle: jobTitle ? jobTitle.trim() : null,
            department: department ? department.trim() : null,
            normalizedJobTitle: normJobTitle,
            normalizedDepartment: normDept,
            reason: `No active authority mapping found for JobTitle="${jobTitle}" and Department="${department}".`
        };
    }

    const row = result.recordset[0];
    return {
        status: 'FOUND',
        authorityRankId: row.Id,
        authorityRank: row.AuthorityRank,
        authorityLevel: row.AuthorityLevel,
        jobTitle: row.JobTitle,
        department: row.Department,
        normalizedJobTitle: row.NormalizedJobTitle,
        normalizedDepartment: row.NormalizedDepartment,
        isActive: Boolean(row.IsActive)
    };
}

/**
 * Retrieves the authority rank for an employee by their ID or email.
 * 
 * @param {number|string} employeeIdOrEmail - Employee numeric ID or email address
 * @returns {Promise<object>} Employee authority details or NOT_FOUND status object
 */
async function getEmployeeAuthority(employeeIdOrEmail) {
    if (employeeIdOrEmail === undefined || employeeIdOrEmail === null || employeeIdOrEmail === '') {
        throw new ValidationError('Employee ID or email is required.');
    }

    const pool = await getPool();
    const req = pool.request();

    let query = `
        SELECT 
            e.EmployeeId,
            e.EmployeeName,
            e.Email,
            e.EntraObjectId,
            e.JobTitle,
            e.NormalizedJobTitle,
            e.Department,
            e.NormalizedDepartment,
            e.AuthorityRankId,
            e.IsActive AS EmployeeIsActive,
            a.Id AS AuthorityMappingId,
            a.AuthorityRank,
            a.AuthorityLevel,
            a.IsActive AS AuthorityIsActive
        FROM dbo.EmployeeDetails e
        LEFT JOIN dbo.AuthorityRank a ON e.AuthorityRankId = a.Id
        WHERE 
    `;

    const numericId = Number(employeeIdOrEmail);
    if (Number.isInteger(numericId) && numericId > 0 && String(numericId) === String(employeeIdOrEmail).trim()) {
        req.input('EmployeeId', sql.Int, numericId);
        query += ` e.EmployeeId = @EmployeeId`;
    } else {
        const normEmail = normalizeEmail(String(employeeIdOrEmail));
        if (!normEmail) {
            throw new ValidationError('Invalid employee email identifier.');
        }
        req.input('NormEmail', sql.NVarChar(255), normEmail);
        query += ` e.NormalizedEmail = @NormEmail`;
    }

    const result = await req.query(query);
    if (result.recordset.length === 0) {
        throw new NotFoundError(`Employee "${employeeIdOrEmail}" was not found.`);
    }

    const row = result.recordset[0];

    // If an active authority mapping is already linked
    if (row.AuthorityRankId && row.AuthorityRank && row.AuthorityIsActive) {
        return {
            status: 'FOUND',
            employeeId: row.EmployeeId,
            employeeName: row.EmployeeName,
            email: row.Email,
            jobTitle: row.JobTitle,
            department: row.Department,
            authorityRankId: row.AuthorityRankId,
            authorityRank: row.AuthorityRank,
            authorityLevel: row.AuthorityLevel,
            isAssigned: true
        };
    }

    // If Job Title and Department exist, check if an unlinked mapping now exists
    if (row.JobTitle && row.Department) {
        const lookup = await getAuthorityByJobTitleAndDepartment(row.JobTitle, row.Department);
        if (lookup.status === 'FOUND') {
            return {
                status: 'FOUND',
                employeeId: row.EmployeeId,
                employeeName: row.EmployeeName,
                email: row.Email,
                jobTitle: row.JobTitle,
                department: row.Department,
                authorityRankId: lookup.authorityRankId,
                authorityRank: lookup.authorityRank,
                authorityLevel: lookup.authorityLevel,
                isAssigned: false, // Discovered via lookup, not yet stored in EmployeeDetails
                notice: 'Authority mapping discovered but not yet persisted to EmployeeDetails. Call assignEmployeeAuthority() to link.'
            };
        }
    }

    return {
        status: 'AUTHORITY_MAPPING_NOT_FOUND',
        employeeId: row.EmployeeId,
        employeeName: row.EmployeeName,
        email: row.Email,
        jobTitle: row.JobTitle,
        department: row.Department,
        authorityRankId: null,
        authorityRank: null,
        authorityLevel: null,
        reason: (!row.JobTitle || !row.Department)
            ? 'Employee has no Job Title or Department configured.'
            : `No active authority mapping found for JobTitle="${row.JobTitle}" and Department="${row.Department}".`
    };
}

/**
 * Assigns or updates the deterministic AuthorityRank for an employee based on
 * their Job Title and Department.
 * 
 * @param {number} employeeId - Numeric EmployeeId in dbo.EmployeeDetails
 * @param {string} [jobTitle] - Optional new Job Title (uses existing if omitted)
 * @param {string} [department] - Optional new Department (uses existing if omitted)
 * @returns {Promise<object>} Updated employee record with authority status
 */
async function assignEmployeeAuthority(employeeId, jobTitle = null, department = null) {
    const id = Number(employeeId);
    if (!Number.isInteger(id) || id <= 0) {
        throw new ValidationError('A valid numeric EmployeeId is required.');
    }

    const pool = await getPool();

    // 1. Fetch current employee
    const empResult = await pool.request()
        .input('EmployeeId', sql.Int, id)
        .query(`SELECT EmployeeId, EmployeeName, Email, JobTitle, Department, IsActive FROM dbo.EmployeeDetails WHERE EmployeeId = @EmployeeId`);

    if (empResult.recordset.length === 0) {
        throw new NotFoundError(`Employee with ID ${id} was not found.`);
    }

    const currentEmp = empResult.recordset[0];
    const effectiveJobTitle = jobTitle !== null && jobTitle !== undefined ? jobTitle : currentEmp.JobTitle;
    const effectiveDept = department !== null && department !== undefined ? department : currentEmp.Department;

    const normJobTitle = normalizeJobTitle(effectiveJobTitle);
    const normDept = normalizeDepartment(effectiveDept);

    if (!normJobTitle || !normDept) {
        // Cannot assign authority without both fields
        await pool.request()
            .input('EmployeeId', sql.Int, id)
            .input('JobTitle', sql.NVarChar(150), effectiveJobTitle ? effectiveJobTitle.trim() : null)
            .input('NormJobTitle', sql.NVarChar(150), normJobTitle)
            .input('Department', sql.NVarChar(100), effectiveDept ? effectiveDept.trim() : null)
            .input('NormDept', sql.NVarChar(100), normDept)
            .query(`
                UPDATE dbo.EmployeeDetails
                SET JobTitle = @JobTitle,
                    NormalizedJobTitle = @NormJobTitle,
                    Department = @Department,
                    NormalizedDepartment = @NormDept,
                    AuthorityRankId = NULL,
                    UpdatedAt = SYSUTCDATETIME()
                WHERE EmployeeId = @EmployeeId
            `);

        return {
            status: 'AUTHORITY_MAPPING_NOT_FOUND',
            employeeId: id,
            jobTitle: effectiveJobTitle,
            department: effectiveDept,
            authorityRankId: null,
            authorityRank: null,
            authorityLevel: null,
            reason: 'Job Title and Department are both required to assign an authority rank.'
        };
    }

    // 2. Perform deterministic authority lookup
    const lookup = await getAuthorityByJobTitleAndDepartment(effectiveJobTitle, effectiveDept);

    if (lookup.status !== 'FOUND') {
        // Clear or leave unassigned rank
        await pool.request()
            .input('EmployeeId', sql.Int, id)
            .input('JobTitle', sql.NVarChar(150), effectiveJobTitle.trim())
            .input('NormJobTitle', sql.NVarChar(150), normJobTitle)
            .input('Department', sql.NVarChar(100), effectiveDept.trim())
            .input('NormDept', sql.NVarChar(100), normDept)
            .query(`
                UPDATE dbo.EmployeeDetails
                SET JobTitle = @JobTitle,
                    NormalizedJobTitle = @NormJobTitle,
                    Department = @Department,
                    NormalizedDepartment = @NormDept,
                    AuthorityRankId = NULL,
                    UpdatedAt = SYSUTCDATETIME()
                WHERE EmployeeId = @EmployeeId
            `);

        return {
            status: 'AUTHORITY_MAPPING_NOT_FOUND',
            employeeId: id,
            jobTitle: effectiveJobTitle,
            department: effectiveDept,
            authorityRankId: null,
            authorityRank: null,
            authorityLevel: null,
            reason: lookup.reason
        };
    }

    // 3. Persist the assigned AuthorityRankId into dbo.EmployeeDetails
    await pool.request()
        .input('EmployeeId', sql.Int, id)
        .input('JobTitle', sql.NVarChar(150), effectiveJobTitle.trim())
        .input('NormJobTitle', sql.NVarChar(150), normJobTitle)
        .input('Department', sql.NVarChar(100), effectiveDept.trim())
        .input('NormDept', sql.NVarChar(100), normDept)
        .input('AuthorityRankId', sql.Int, lookup.authorityRankId)
        .query(`
            UPDATE dbo.EmployeeDetails
            SET JobTitle = @JobTitle,
                NormalizedJobTitle = @NormJobTitle,
                Department = @Department,
                NormalizedDepartment = @NormDept,
                AuthorityRankId = @AuthorityRankId,
                UpdatedAt = SYSUTCDATETIME()
            WHERE EmployeeId = @EmployeeId
        `);

    return {
        status: 'ASSIGNED',
        employeeId: id,
        jobTitle: lookup.jobTitle,
        department: lookup.department,
        authorityRankId: lookup.authorityRankId,
        authorityRank: lookup.authorityRank,
        authorityLevel: lookup.authorityLevel
    };
}

module.exports = {
    getAuthorityByJobTitleAndDepartment,
    getEmployeeAuthority,
    assignEmployeeAuthority
};

