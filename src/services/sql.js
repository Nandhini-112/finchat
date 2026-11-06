require('../utils/config');
const sql = require('mssql');

let pool = null;
let schemaInitialized = false;

async function ensureDatabaseSchema(p) {
    if (schemaInitialized) return;

    try {
        await p.request().batch(`
            -- 1. Source Authority Ranks Table
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'SourceAuthorityRanks')
            BEGIN
                CREATE TABLE dbo.SourceAuthorityRanks (
                    AuthorityRank INT NOT NULL PRIMARY KEY,
                    SourceType NVARCHAR(100) NOT NULL,
                    Description NVARCHAR(500) NULL
                );

                INSERT INTO dbo.SourceAuthorityRanks (AuthorityRank, SourceType, Description) VALUES
                (1, 'Audited Financials', 'Audited statutory filings and reports (Highest authority)'),
                (2, 'Board Packs / Final', 'Approved board reports, executive packs, final settlement files'),
                (3, 'Drafts / Working Files', 'Draft estimates, working ledgers, unapproved reports'),
                (4, 'Sample / Test', 'Sample test documents and synthetic datasets');
            END;

            -- 2. Ingestion Runs Table
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'IngestionRuns')
            BEGIN
                CREATE TABLE dbo.IngestionRuns (
                    RunId BIGINT IDENTITY(1,1) PRIMARY KEY,
                    StartedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CompletedAt DATETIME2 NULL,
                    FilesDiscovered INT NOT NULL DEFAULT 1,
                    FilesSucceeded INT NOT NULL DEFAULT 0,
                    FilesFailed INT NOT NULL DEFAULT 0,
                    RunStatus NVARCHAR(30) NOT NULL DEFAULT 'Processing',
                    ErrorSummary NVARCHAR(MAX) NULL
                );
            END;

            -- 3. Documents Table
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Documents')
            BEGIN
                CREATE TABLE dbo.Documents (
                    DocumentId BIGINT IDENTITY(1,1) PRIMARY KEY,
                    FileName NVARCHAR(260) NOT NULL,
                    SourceType NVARCHAR(50) NOT NULL DEFAULT 'ManualUpload',
                    SharePointFileId NVARCHAR(300) NULL,
                    SourceUrl NVARCHAR(1000) NULL,
                    FileVersion NVARCHAR(100) NULL,
                    AuthorityRank INT NULL FOREIGN KEY REFERENCES dbo.SourceAuthorityRanks(AuthorityRank),
                    AllowedUserGroups NVARCHAR(1000) NULL,
                    IngestionStatus NVARCHAR(30) NOT NULL DEFAULT 'Processing',
                    LastProcessedAt DATETIME2 NULL,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME(),
                    CreatedByUserId NVARCHAR(255) NULL,
                    CreatedByName NVARCHAR(150) NULL,
                    CreatedByEmail NVARCHAR(255) NULL,
                    CreatedByDepartment NVARCHAR(100) NULL,
                    ModifiedByUserId NVARCHAR(255) NULL,
                    ModifiedByName NVARCHAR(150) NULL,
                    ModifiedByEmail NVARCHAR(255) NULL,
                    ModifiedAt DATETIME2 NULL,
                    ProcessingError NVARCHAR(MAX) NULL
                );
            END;

            -- 4. Financial Facts Table
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'FinancialFacts')
            BEGIN
                CREATE TABLE dbo.FinancialFacts (
                    FactId BIGINT IDENTITY(1,1) PRIMARY KEY,
                    DocumentId BIGINT NOT NULL FOREIGN KEY REFERENCES dbo.Documents(DocumentId),
                    Metric NVARCHAR(200) NOT NULL,
                    Entity NVARCHAR(200) NULL,
                    PeriodLabel NVARCHAR(100) NULL,
                    FactDate DATE NULL,
                    AsOfDate DATE NULL,
                    NumericValue DECIMAL(19,4) NULL,
                    TextValue NVARCHAR(2000) NULL,
                    Unit NVARCHAR(50) NULL,
                    Currency NVARCHAR(10) NULL,
                    SourceLocation NVARCHAR(300) NULL,
                    SourceFileName NVARCHAR(260) NULL,
                    AuthorityRank INT NULL FOREIGN KEY REFERENCES dbo.SourceAuthorityRanks(AuthorityRank),
                    ValidationStatus NVARCHAR(30) NOT NULL DEFAULT 'Validated',
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
                );
                CREATE INDEX IX_FinancialFacts_DocumentId ON dbo.FinancialFacts(DocumentId);
                CREATE INDEX IX_FinancialFacts_Metric ON dbo.FinancialFacts(Metric);
            END;

            -- 5. Fact Conflicts Table
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'FactConflicts')
            BEGIN
                CREATE TABLE dbo.FactConflicts (
                    ConflictId BIGINT IDENTITY(1,1) PRIMARY KEY,
                    FactId1 BIGINT NOT NULL FOREIGN KEY REFERENCES dbo.FinancialFacts(FactId),
                    FactId2 BIGINT NOT NULL FOREIGN KEY REFERENCES dbo.FinancialFacts(FactId),
                    ConflictReason NVARCHAR(1000) NOT NULL,
                    ResolutionStatus NVARCHAR(30) NOT NULL DEFAULT 'Unresolved',
                    ResolutionNotes NVARCHAR(2000) NULL,
                    ReviewedAt DATETIME2 NULL,
                    CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
                );
            END;

            --6. Authority rank Table
            -- AuthorityRank Table
                IF NOT EXISTS (
                     SELECT *FROM sys.tables WHERE name = 'AuthorityRank')
                BEGIN
                    CREATE TABLE dbo.AuthorityRank (
                    Id INT IDENTITY(1,1) PRIMARY KEY,
                    CreatedByName NVARCHAR(150) NULL,
                    CreatedByEmail NVARCHAR(255) NULL,
                    CreatedByUserId NVARCHAR(255) NULL,
                    JobTitle NVARCHAR(150) NOT NULL,
                    Department NVARCHAR(100) NOT NULL,
                    AuthorityRank INT NOT NULL,
                    AuthorityLevel NVARCHAR(50) NULL,
                    IsActive BIT NOT NULL DEFAULT 1,
                    CreatedAt DATETIME2 NULL DEFAULT SYSUTCDATETIME()
               );
            END;
        `);
        schemaInitialized = true;
    } catch (err) {
        // Log warning if schema check cannot run yet (e.g. read-only user or initial probe)
        console.warn('Notice: Automatic database schema initialization encountered an issue:', err.message);
    }
}

async function getPool() {
    if (pool && pool.connected) {
        return pool;
    }

    const config = {
        server: process.env.AZURE_SQL_SERVER,
        database: process.env.AZURE_SQL_DATABASE,
        user: process.env.AZURE_SQL_USER,
        password: process.env.AZURE_SQL_PASSWORD,
        options: {
            encrypt: process.env.AZURE_SQL_ENCRYPT !== 'false',
            trustServerCertificate: false
        },
        connectionTimeout: 60000,
        requestTimeout: 60000,
        pool: {
            max: 10,
            min: 0,
            idleTimeoutMillis: 30000
        }
    };

    pool = await sql.connect(config);
    await ensureDatabaseSchema(pool);
    return pool;
}

async function ensureDefaultAuthorityRank(rank = 4, sourceType = 'ManualUpload', description = 'Manual document upload') {
    const p = await getPool();
    await p.request()
        .input('Rank', sql.Int, rank)
        .input('SourceType', sql.NVarChar(100), sourceType)
        .input('Description', sql.NVarChar(500), description)
        .query(`
            IF NOT EXISTS (SELECT 1 FROM dbo.SourceAuthorityRanks WHERE AuthorityRank = @Rank)
            BEGIN
                INSERT INTO dbo.SourceAuthorityRanks (AuthorityRank, SourceType, Description)
                VALUES (@Rank, @SourceType, @Description)
            END
        `);
}

async function startIngestionRun(filesDiscovered = 1) {
    const p = await getPool();
    const result = await p.request()
        .input('FilesDiscovered', sql.Int, filesDiscovered)
        .query(`
            INSERT INTO dbo.IngestionRuns 
                (StartedAt, FilesDiscovered, FilesSucceeded, FilesFailed, RunStatus)
            OUTPUT INSERTED.RunId
            VALUES 
                (SYSUTCDATETIME(), @FilesDiscovered, 0, 0, 'Processing')
        `);
    return result.recordset[0].RunId;
}

async function completeIngestionRun(runId, filesSucceeded, filesFailed, runStatus, errorSummary = null) {
    const p = await getPool();
    await p.request()
        .input('RunId', sql.BigInt, runId)
        .input('FilesSucceeded', sql.Int, filesSucceeded)
        .input('FilesFailed', sql.Int, filesFailed)
        .input('RunStatus', sql.NVarChar(30), runStatus)
        .input('ErrorSummary', sql.NVarChar(sql.MAX), errorSummary)
        .query(`
            UPDATE dbo.IngestionRuns
            SET CompletedAt = SYSUTCDATETIME(),
                FilesSucceeded = @FilesSucceeded,
                FilesFailed = @FilesFailed,
                RunStatus = @RunStatus,
                ErrorSummary = @ErrorSummary
            WHERE RunId = @RunId
        `);
}

async function updateIngestionRunProgress(runId, isSuccess = true, errorSummary = null) {
    if (!runId) return;
    const p = await getPool();
    await p.request()
        .input('RunId', sql.BigInt, runId)
        .input('IsSuccess', sql.Bit, isSuccess ? 1 : 0)
        .input('ErrorSummary', sql.NVarChar(sql.MAX), errorSummary)
        .query(`
            UPDATE dbo.IngestionRuns
            SET FilesSucceeded = FilesSucceeded + CASE WHEN @IsSuccess = 1 THEN 1 ELSE 0 END,
                FilesFailed = FilesFailed + CASE WHEN @IsSuccess = 0 THEN 1 ELSE 0 END,
                ErrorSummary = CASE 
                    WHEN @ErrorSummary IS NOT NULL AND ErrorSummary IS NULL THEN @ErrorSummary
                    WHEN @ErrorSummary IS NOT NULL THEN SUBSTRING(ErrorSummary + CHAR(10) + @ErrorSummary, 1, 4000)
                    ELSE ErrorSummary
                END
            WHERE RunId = @RunId
        `);
}

async function createDocument(fileName, sourceType = 'ManualUpload', authorityRank = 4, allowedUserGroups = null) {
    await ensureDefaultAuthorityRank(authorityRank, sourceType);
    const p = await getPool();
    const result = await p.request()
        .input('FileName', sql.NVarChar(260), fileName)
        .input('SourceType', sql.NVarChar(50), sourceType)
        .input('AuthorityRank', sql.Int, authorityRank)
        .input('AllowedUserGroups', sql.NVarChar(1000), allowedUserGroups)
        .query(`
            INSERT INTO dbo.Documents 
                (FileName, SourceType, AuthorityRank, AllowedUserGroups, IngestionStatus, CreatedAt)
            OUTPUT INSERTED.DocumentId
            VALUES 
                (@FileName, @SourceType, @AuthorityRank, @AllowedUserGroups, 'Processing', SYSUTCDATETIME())
        `);
    return result.recordset[0].DocumentId;
}

async function updateDocumentStatus(documentId, status) {
    const p = await getPool();
    await p.request()
        .input('DocumentId', sql.BigInt, documentId)
        .input('Status', sql.NVarChar(30), status)
        .query(`
            UPDATE dbo.Documents
            SET IngestionStatus = @Status,
                LastProcessedAt = SYSUTCDATETIME()
            WHERE DocumentId = @DocumentId
        `);
}

async function insertFinancialFacts(documentId, facts, defaultRank = 4, sourceFileName = null) {
    if (!facts || facts.length === 0) return [];
    const p = await getPool();
    const insertedIds = [];

    for (const fact of facts) {
        const factFileName = fact.sourceFileName || sourceFileName || null;
        const asOfDate = fact.asOfDate || fact.factDate || null;

        const req = p.request()
            .input('DocumentId', sql.BigInt, documentId)
            .input('Metric', sql.NVarChar(200), fact.metric)
            .input('Entity', sql.NVarChar(200), fact.entity || null)
            .input('PeriodLabel', sql.NVarChar(100), fact.periodLabel || 'Not specified')
            .input('FactDate', sql.Date, fact.factDate || null)
            .input('AsOfDate', sql.Date, asOfDate)
            .input('NumericValue', sql.Decimal(19, 4), fact.numericValue !== undefined ? fact.numericValue : null)
            .input('TextValue', sql.NVarChar(2000), fact.textValue || null)
            .input('Unit', sql.NVarChar(50), fact.unit || null)
            .input('Currency', sql.NVarChar(10), fact.currency || (fact.unit === 'count' ? null : 'USD'))
            .input('SourceLocation', sql.NVarChar(300), fact.sourceLocation || null)
            .input('SourceFileName', sql.NVarChar(260), factFileName)
            .input('AuthorityRank', sql.Int, fact.authorityRank || defaultRank)
            .input('ValidationStatus', sql.NVarChar(30), fact.validationStatus || 'Validated');

        const result = await req.query(`
            INSERT INTO dbo.FinancialFacts
                (DocumentId, Metric, Entity, PeriodLabel, FactDate, AsOfDate,
                 NumericValue, TextValue, Unit, Currency, SourceLocation, SourceFileName,
                 AuthorityRank, ValidationStatus, CreatedAt)
            OUTPUT INSERTED.FactId
            VALUES
                (@DocumentId, @Metric, @Entity, @PeriodLabel, @FactDate, @AsOfDate,
                 @NumericValue, @TextValue, @Unit, @Currency, @SourceLocation, @SourceFileName,
                 @AuthorityRank, @ValidationStatus, SYSUTCDATETIME())
        `);

        insertedIds.push(result.recordset[0].FactId);
    }

    return insertedIds;
}

/**
 * Retrieves a document by its DocumentId or FileName
 */
async function getDocumentById(documentId) {
    const p = await getPool();
    const req = p.request();
    let query = '';

    const numId = Number(documentId);
    if (!isNaN(numId) && numId > 0) {
        req.input('DocumentId', sql.BigInt, numId);
        query = 'SELECT * FROM dbo.Documents WHERE DocumentId = @DocumentId';
    } else {
        req.input('FileName', sql.NVarChar(260), String(documentId));
        query = 'SELECT TOP 1 * FROM dbo.Documents WHERE FileName = @FileName ORDER BY DocumentId DESC';
    }

    const result = await req.query(query);
    return result.recordset[0] || null;
}

/**
 * Retrieves structured financial facts for a document
 */
async function getFinancialFacts(documentId = null) {
    const p = await getPool();
    const req = p.request();

    let query = `
        SELECT f.FactId, f.DocumentId, f.Metric, f.Entity, f.PeriodLabel, f.FactDate, f.AsOfDate,
               f.NumericValue, f.TextValue, f.Unit, f.Currency, f.SourceLocation,
               ISNULL(f.SourceFileName, d.FileName) AS SourceFileName,
               ISNULL(f.AuthorityRank, d.AuthorityRank) AS AuthorityRank,
               f.ValidationStatus, f.CreatedAt,
               r.SourceType AS AuthorityType
        FROM dbo.FinancialFacts f
        LEFT JOIN dbo.Documents d ON f.DocumentId = d.DocumentId
        LEFT JOIN dbo.SourceAuthorityRanks r ON ISNULL(f.AuthorityRank, d.AuthorityRank) = r.AuthorityRank
        WHERE (d.IngestionStatus = 'Succeeded' OR d.IngestionStatus IS NULL)
    `;

    if (documentId) {
        const numId = Number(documentId);
        if (!isNaN(numId) && numId > 0) {
            req.input('DocumentId', sql.BigInt, numId);
            query += ' AND f.DocumentId = @DocumentId';
        }
    }

    query += ' ORDER BY f.FactId ASC';
    const result = await req.query(query);
    return result.recordset;
}

/**
 * Removes all facts and associated conflicts for a failed or retracted document.
 * Guarantees that failed files leave zero stray facts in the database.
 */
async function deleteDocumentFacts(documentId) {
    if (!documentId) return;
    const p = await getPool();
    await p.request()
        .input('DocumentId', sql.BigInt, Number(documentId))
        .query(`
            DELETE FROM dbo.FactConflicts 
            WHERE FactId1 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocumentId)
               OR FactId2 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocumentId);

            DELETE FROM dbo.FinancialFacts WHERE DocumentId = @DocumentId;
        `);
}

module.exports = {
    getPool,
    startIngestionRun,
    completeIngestionRun,
    updateIngestionRunProgress,
    createDocument,
    updateDocumentStatus,
    insertFinancialFacts,
    getDocumentById,
    getFinancialFacts,
    deleteDocumentFacts
};

