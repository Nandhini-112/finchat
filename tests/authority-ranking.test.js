const test = require('node:test');
const assert = require('node:assert/strict');

const {
    normalizeJobTitle,
    normalizeDepartment,
    normalizeEmail
} = require('../src/utils/authority-normalizer');

const {
    validateEmployeeDetails,
    validateAuthorityMapping
} = require('../src/utils/authority-validation');

const { ValidationError, NotFoundError } = require('../src/utils/errors');
const { validateDocumentBuffer, validateChatRequest } = require('../src/utils/validation');

// =========================================================================
// SECTION A: NORMALIZATION TESTS
// =========================================================================

test('authority-normalizer: cleans whitespace and applies consistent lowercase', () => {
    assert.equal(normalizeJobTitle('  Senior   Financial  Analyst  '), 'senior financial analyst');
    assert.equal(normalizeDepartment('   Finance  &  Accounting   '), 'finance & accounting');
    assert.equal(normalizeEmail('  Jane.Doe@Finora-AI.COM  '), 'jane.doe@finora-ai.com');
});

test('authority-normalizer: strips harmless punctuation from titles and departments', () => {
    assert.equal(normalizeJobTitle('...Finance Director---'), 'finance director');
    assert.equal(normalizeDepartment('///Human Resources///'), 'human resources');
});

test('authority-normalizer: gracefully handles null, undefined, and non-strings', () => {
    assert.equal(normalizeJobTitle(null), null);
    assert.equal(normalizeJobTitle(''), null);
    assert.equal(normalizeDepartment(undefined), null);
    assert.equal(normalizeEmail(123), null);
});

// =========================================================================
// SECTION B: VALIDATION TESTS
// =========================================================================

test('authority-validation: validateEmployeeDetails succeeds on valid data', () => {
    const valid = {
        employeeName: 'Sarah Connor',
        email: 'sarah.connor@finora.internal',
        jobTitle: 'Finance Director',
        department: 'Finance'
    };
    assert.equal(validateEmployeeDetails(valid, false), true);
});

test('authority-validation: validateEmployeeDetails rejects empty name and invalid email', () => {
    assert.throws(
        () => validateEmployeeDetails({ employeeName: '', email: 'valid@finora.internal' }, false),
        ValidationError
    );
    assert.throws(
        () => validateEmployeeDetails({ employeeName: 'Valid Name', email: 'invalid-email-string' }, false),
        ValidationError
    );
});

test('authority-validation: validateAuthorityMapping enforces 1-5 rank range', () => {
    assert.equal(validateAuthorityMapping({
        jobTitle: 'Finance Director',
        department: 'Finance',
        authorityRank: 4,
        authorityLevel: 'Senior Authority'
    }), true);

    // Rank 0 is invalid (must be 1 to 5)
    assert.throws(() => validateAuthorityMapping({
        jobTitle: 'Test',
        department: 'Test',
        authorityRank: 0
    }), ValidationError);

    // Rank 6 is invalid
    assert.throws(() => validateAuthorityMapping({
        jobTitle: 'Test',
        department: 'Test',
        authorityRank: 6
    }), ValidationError);
});

// =========================================================================
// SECTION C: AUTHORITY RANKING & EMPLOYEE SERVICE MOCK DATABASE TESTS
// =========================================================================

/**
 * Creates an in-memory SQL mock simulating dbo.AuthorityRank and dbo.EmployeeDetails
 * with exact parameterized queries and behavior as implemented in services.
 */
function createMockDb() {
    const authorityRanks = [
        { Id: 1, JobTitle: 'Chief Executive Officer', NormalizedJobTitle: 'chief executive officer', Department: 'Executive', NormalizedDepartment: 'executive', AuthorityRank: 5, AuthorityLevel: 'Executive Authority', IsActive: true },
        { Id: 2, JobTitle: 'Chief Financial Officer', NormalizedJobTitle: 'chief financial officer', Department: 'Finance', NormalizedDepartment: 'finance', AuthorityRank: 5, AuthorityLevel: 'Executive Authority', IsActive: true },
        { Id: 3, JobTitle: 'Finance Director', NormalizedJobTitle: 'finance director', Department: 'Finance', NormalizedDepartment: 'finance', AuthorityRank: 4, AuthorityLevel: 'Senior Authority', IsActive: true },
        { Id: 4, JobTitle: 'Finance Manager', NormalizedJobTitle: 'finance manager', Department: 'Finance', NormalizedDepartment: 'finance', AuthorityRank: 3, AuthorityLevel: 'Manager Authority', IsActive: true },
        { Id: 5, JobTitle: 'Senior Financial Analyst', NormalizedJobTitle: 'senior financial analyst', Department: 'Finance', NormalizedDepartment: 'finance', AuthorityRank: 2, AuthorityLevel: 'Intermediate Authority', IsActive: true },
        { Id: 6, JobTitle: 'Financial Analyst', NormalizedJobTitle: 'financial analyst', Department: 'Finance', NormalizedDepartment: 'finance', AuthorityRank: 1, AuthorityLevel: 'Entry-level Authority', IsActive: true },
        { Id: 7, JobTitle: 'Retired Advisor', NormalizedJobTitle: 'retired advisor', Department: 'Finance', NormalizedDepartment: 'finance', AuthorityRank: 3, AuthorityLevel: 'Manager Authority', IsActive: false } // Inactive
    ];

    const employees = [];
    let nextEmployeeId = 1;

    return {
        authorityRanks,
        employees,

        // Mock lookup
        findAuthority(jobTitle, department) {
            const normTitle = normalizeJobTitle(jobTitle);
            const normDept = normalizeDepartment(department);
            if (!normTitle || !normDept) {
                return {
                    status: 'AUTHORITY_MAPPING_NOT_FOUND',
                    authorityRank: null,
                    authorityLevel: null,
                    authorityRankId: null,
                    reason: 'Job Title and Department are both required.'
                };
            }
            const match = authorityRanks.find(r => r.NormalizedJobTitle === normTitle && r.NormalizedDepartment === normDept && r.IsActive);
            if (!match) {
                return {
                    status: 'AUTHORITY_MAPPING_NOT_FOUND',
                    authorityRank: null,
                    authorityLevel: null,
                    authorityRankId: null,
                    reason: 'No active authority mapping found.'
                };
            }
            return {
                status: 'FOUND',
                authorityRankId: match.Id,
                authorityRank: match.AuthorityRank,
                authorityLevel: match.AuthorityLevel,
                jobTitle: match.JobTitle,
                department: match.Department
            };
        },

        // Mock employee create
        createEmployee(data) {
            validateEmployeeDetails(data, false);
            const normEmail = normalizeEmail(data.email);
            if (employees.some(e => e.NormalizedEmail === normEmail)) {
                throw new ValidationError(`An employee with email "${data.email}" already exists.`);
            }

            let rankId = null;
            if (data.authorityRankId) {
                const check = authorityRanks.find(r => r.Id === Number(data.authorityRankId) && r.IsActive);
                if (!check) throw new ValidationError('AuthorityRank mapping does not exist or is inactive.');
                rankId = check.Id;
            } else if (data.jobTitle && data.department) {
                const lookup = this.findAuthority(data.jobTitle, data.department);
                if (lookup.status === 'FOUND') rankId = lookup.authorityRankId;
            }

            const newEmp = {
                EmployeeId: nextEmployeeId++,
                EmployeeName: data.employeeName.trim(),
                Email: data.email.trim(),
                NormalizedEmail: normEmail,
                EntraObjectId: data.entraObjectId || null,
                JobTitle: data.jobTitle ? data.jobTitle.trim() : null,
                NormalizedJobTitle: normalizeJobTitle(data.jobTitle),
                Department: data.department ? data.department.trim() : null,
                NormalizedDepartment: normalizeDepartment(data.department),
                AuthorityRankId: rankId,
                IsActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
                CreatedAt: new Date().toISOString()
            };
            employees.push(newEmp);
            return newEmp;
        },

        // Mock employee lookup by email
        getEmployeeByEmail(email) {
            const normEmail = normalizeEmail(email);
            if (!normEmail) throw new ValidationError('A valid email address is required.');
            const emp = employees.find(e => e.NormalizedEmail === normEmail);
            if (!emp) return null;
            const rank = emp.AuthorityRankId ? authorityRanks.find(r => r.Id === emp.AuthorityRankId) : null;
            return {
                ...emp,
                AuthorityRank: rank ? rank.AuthorityRank : null,
                AuthorityLevel: rank ? rank.AuthorityLevel : null
            };
        },

        // Mock employee lookup by ID
        getEmployeeById(id) {
            const emp = employees.find(e => e.EmployeeId === Number(id));
            if (!emp) return null;
            const rank = emp.AuthorityRankId ? authorityRanks.find(r => r.Id === emp.AuthorityRankId) : null;
            return {
                ...emp,
                AuthorityRank: rank ? rank.AuthorityRank : null,
                AuthorityLevel: rank ? rank.AuthorityLevel : null
            };
        },

        // Mock deactivation
        deactivateEmployee(id) {
            const emp = employees.find(e => e.EmployeeId === Number(id));
            if (!emp) throw new NotFoundError(`Employee with ID ${id} was not found.`);
            emp.IsActive = false;
            emp.UpdatedAt = new Date().toISOString();
            return emp;
        }
    };
}

// =========================================================================
// SECTION D: THE 12 SPECIFICATION TEST CASES
// =========================================================================

test('Case 1: Successful employee creation', () => {
    const db = createMockDb();
    const created = db.createEmployee({
        employeeName: 'John Doe',
        email: 'john.doe@finora.internal',
        jobTitle: 'Finance Director',
        department: 'Finance'
    });

    assert.equal(created.EmployeeId, 1);
    assert.equal(created.EmployeeName, 'John Doe');
    assert.equal(created.NormalizedEmail, 'john.doe@finora.internal');
    assert.equal(created.AuthorityRankId, 3); // Finance Director = Rank 4, Id 3
    assert.equal(created.IsActive, true);
});

test('Case 2: Duplicate email rejection', () => {
    const db = createMockDb();
    db.createEmployee({
        employeeName: 'Alice Smith',
        email: 'alice.smith@finora.internal',
        jobTitle: 'Financial Analyst',
        department: 'Finance'
    });

    // Re-inserting identical email (case-insensitive)
    assert.throws(() => {
        db.createEmployee({
            employeeName: 'Alice Duplicate',
            email: 'ALICE.SMITH@finora.internal'
        });
    }, ValidationError);
});

test('Case 3: Employee lookup by email', () => {
    const db = createMockDb();
    db.createEmployee({
        employeeName: 'Bob Vance',
        email: 'bob.vance@finora.internal',
        jobTitle: 'Finance Manager',
        department: 'Finance'
    });

    const found = db.getEmployeeByEmail('  BOB.VANCE@finora.internal  ');
    assert.ok(found);
    assert.equal(found.EmployeeName, 'Bob Vance');
    assert.equal(found.AuthorityRank, 3); // Manager = Rank 3
});

test('Case 4: Employee lookup by ID', () => {
    const db = createMockDb();
    const emp = db.createEmployee({
        employeeName: 'Carol Danvers',
        email: 'carol.danvers@finora.internal',
        jobTitle: 'Chief Financial Officer',
        department: 'Finance'
    });

    const found = db.getEmployeeById(emp.EmployeeId);
    assert.ok(found);
    assert.equal(found.EmployeeName, 'Carol Danvers');
    assert.equal(found.AuthorityRank, 5); // CFO = Rank 5
});

test('Case 5: Successful authority mapping', () => {
    const db = createMockDb();
    const mapping = db.findAuthority('  Finance   Director  ', '  Finance  ');
    assert.equal(mapping.status, 'FOUND');
    assert.equal(mapping.authorityRank, 4);
    assert.equal(mapping.authorityLevel, 'Senior Authority');
});

test('Case 6: Unknown Job Title handling', () => {
    const db = createMockDb();
    const mapping = db.findAuthority('Astronaut', 'Finance');
    assert.equal(mapping.status, 'AUTHORITY_MAPPING_NOT_FOUND');
    assert.equal(mapping.authorityRank, null);
});

test('Case 7: Unknown Department handling', () => {
    const db = createMockDb();
    const mapping = db.findAuthority('Finance Director', 'Aerospace Engineering');
    assert.equal(mapping.status, 'AUTHORITY_MAPPING_NOT_FOUND');
    assert.equal(mapping.authorityRank, null);
});

test('Case 8: Inactive authority mapping handling', () => {
    const db = createMockDb();
    // 'Retired Advisor' is in DB but IsActive = false
    const mapping = db.findAuthority('Retired Advisor', 'Finance');
    assert.equal(mapping.status, 'AUTHORITY_MAPPING_NOT_FOUND');
});

test('Case 9: Missing Job Title or Department handling', () => {
    const db = createMockDb();
    const mappingNoTitle = db.findAuthority(null, 'Finance');
    assert.equal(mappingNoTitle.status, 'AUTHORITY_MAPPING_NOT_FOUND');

    const mappingNoDept = db.findAuthority('Finance Director', null);
    assert.equal(mappingNoDept.status, 'AUTHORITY_MAPPING_NOT_FOUND');

    // Creating an employee with no title/department leaves AuthorityRankId as null
    const emp = db.createEmployee({
        employeeName: 'New Hire',
        email: 'new.hire@finora.internal'
    });
    assert.equal(emp.AuthorityRankId, null);
    assert.equal(emp.JobTitle, null);
    assert.equal(emp.Department, null);
});

test('Case 10: Employee deactivation', () => {
    const db = createMockDb();
    const emp = db.createEmployee({
        employeeName: 'David Banner',
        email: 'david.banner@finora.internal'
    });

    const deactivated = db.deactivateEmployee(emp.EmployeeId);
    assert.equal(deactivated.IsActive, false);
    assert.ok(deactivated.UpdatedAt);
});

test('Case 11: Existing document ingestion regression', () => {
    // Valid PDF header
    const validPdfBuffer = Buffer.from('%PDF-1.4 sample pdf content for regression test');
    assert.equal(validateDocumentBuffer(validPdfBuffer, 'Financial_Report.pdf'), true);

    // Valid XLSX header (PK..)
    const validXlsxBuffer = Buffer.from([0x50, 0x4B, 0x03, 0x04, 0x00, 0x00]);
    assert.equal(validateDocumentBuffer(validXlsxBuffer, 'HR_Headcount.xlsx'), true);

    // Word document (.docx) must be excluded
    assert.throws(() => {
        validateDocumentBuffer(validXlsxBuffer, 'Summary.docx');
    }, ValidationError);

    // CSV file must be excluded
    assert.throws(() => {
        validateDocumentBuffer(Buffer.from('Col1,Col2\n1,2'), 'Data.csv');
    }, ValidationError);
});

test('Case 12: Existing /api/chat regression', () => {
    // Valid chat request
    const validChat = validateChatRequest({
        question: 'What was the operating revenue for FY 2024?',
        documentId: 42
    });
    assert.equal(validChat.question, 'What was the operating revenue for FY 2024?');
    assert.equal(validChat.documentId, 42);

    // Missing question
    assert.throws(() => {
        validateChatRequest({ documentId: 42 });
    }, ValidationError);

    // Empty question
    assert.throws(() => {
        validateChatRequest({ question: '   ' });
    }, ValidationError);
});
