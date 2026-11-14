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

            -- 6. AuthorityRank Table
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuthorityRank')
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

            -- 7. Audit Logs Table (Tamper-evident governance trail)
            IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'AuditLogs')
            BEGIN
                CREATE TABLE dbo.AuditLogs (
                    AuditId BIGINT IDENTITY(1,1) PRIMARY KEY,
                    EventType NVARCHAR(50) NOT NULL,
                    DocumentId BIGINT NULL,
                    ConflictId BIGINT NULL,
                    ActionBy NVARCHAR(255) NULL,
                    ActionRole NVARCHAR(50) NULL,
                    PreviousStatus NVARCHAR(50) NULL,
                    NewStatus NVARCHAR(50) NULL,
                    Details NVARCHAR(MAX) NULL,
                    CorrelationId NVARCHAR(100) NULL,
                    Timestamp DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
                );
                CREATE INDEX IX_AuditLogs_DocumentId ON dbo.AuditLogs(DocumentId);
                CREATE INDEX IX_AuditLogs_EventType ON dbo.AuditLogs(EventType);
            END;

            -- Ensure FactConflicts extension columns
            IF NOT EXISTS (SELECT * FROM sys.columns WHERE object_id = OBJECT_ID('dbo.FactConflicts') AND name = 'ResolutionToken')
            BEGIN
                ALTER TABLE dbo.FactConflicts ADD 
                    ResolutionToken NVARCHAR(255) NULL,
                    ProposedResolution NVARCHAR(1000) NULL,
                    ReviewedByEmail NVARCHAR(255) NULL,
                    ReviewedByUserId NVARCHAR(255) NULL;
            END;
        `);
        schemaInitialized = true;
    } catch (err) {
        /// Log warning if schema check cannot run yet (e.g. read-only user or initial probe)
        console.warn('Notice: Automatic database schema initialization encountered an issue:', err.message);
    }
}

async function getPool() {
    if (pool && (pool.connected || pool.isMock)) {
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

function setPool(customPool) {
    pool = customPool;
    schemaInitialized = true;
}

function resetPool() {
    pool = null;
    schemaInitialized = false;
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

async function createDocument(
    fileName,
    sourceType = 'ManualUpload',
    authorityRank = 4,
    allowedUserGroups = null,
    uploaderInfo = {}
) {
    await ensureDefaultAuthorityRank(authorityRank, sourceType);
    const p = await getPool();
    const result = await p.request()
        .input('FileName', sql.NVarChar(260), fileName)
        .input('SourceType', sql.NVarChar(50), sourceType)
        .input('AuthorityRank', sql.Int, authorityRank)
        .input('AllowedUserGroups', sql.NVarChar(1000), allowedUserGroups)
        .input('ModifiedByEmail', sql.NVarChar(255), uploaderInfo.modifiedByEmail || null)
        .input('ModifiedByName', sql.NVarChar(150), uploaderInfo.modifiedByName || null)
        .input('ModifiedByUserId', sql.NVarChar(255), uploaderInfo.modifiedByUserId || null)
        .input('CreatedByEmail', sql.NVarChar(255), uploaderInfo.createdByEmail || uploaderInfo.modifiedByEmail || null)
        .input('CreatedByName', sql.NVarChar(150), uploaderInfo.createdByName || uploaderInfo.modifiedByName || null)
        .input('CreatedByDepartment', sql.NVarChar(100), uploaderInfo.department || null)
        .query(`
            INSERT INTO dbo.Documents 
                (FileName, SourceType, AuthorityRank, AllowedUserGroups, IngestionStatus,
                 ModifiedByEmail, ModifiedByName, ModifiedByUserId,
                 CreatedByEmail, CreatedByName, CreatedByDepartment, CreatedAt)
            OUTPUT INSERTED.DocumentId
            VALUES 
                (@FileName, @SourceType, @AuthorityRank, @AllowedUserGroups, 'Processing',
                 @ModifiedByEmail, @ModifiedByName, @ModifiedByUserId,
                 @CreatedByEmail, @CreatedByName, @CreatedByDepartment, SYSUTCDATETIME())
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

/**
 * Inserts a record into dbo.AuditLogs.
 */
async function insertAuditLog({
    eventType,
    documentId = null,
    conflictId = null,
    actionBy = 'SYSTEM',
    actionRole = 'System',
    previousStatus = null,
    newStatus = null,
    details = null,
    correlationId = null
}) {
    try {
        const p = await getPool();
        const detailsString = details && typeof details === 'object' ? JSON.stringify(details) : (details || null);

        await p.request()
            .input('EventType', sql.NVarChar(50), String(eventType))
            .input('DocumentId', sql.BigInt, documentId ? Number(documentId) : null)
            .input('ConflictId', sql.BigInt, conflictId ? Number(conflictId) : null)
            .input('ActionBy', sql.NVarChar(255), actionBy ? String(actionBy).slice(0, 255) : 'SYSTEM')
            .input('ActionRole', sql.NVarChar(50), actionRole ? String(actionRole).slice(0, 50) : 'System')
            .input('PreviousStatus', sql.NVarChar(50), previousStatus ? String(previousStatus).slice(0, 50) : null)
            .input('NewStatus', sql.NVarChar(50), newStatus ? String(newStatus).slice(0, 50) : null)
            .input('Details', sql.NVarChar(sql.MAX), detailsString)
            .input('CorrelationId', sql.NVarChar(100), correlationId ? String(correlationId).slice(0, 100) : null)
            .query(`
                INSERT INTO dbo.AuditLogs 
                    (EventType, DocumentId, ConflictId, ActionBy, ActionRole,
                     PreviousStatus, NewStatus, Details, CorrelationId, Timestamp)
                VALUES 
                    (@EventType, @DocumentId, @ConflictId, @ActionBy, @ActionRole,
                     @PreviousStatus, @NewStatus, @Details, @CorrelationId, SYSUTCDATETIME());
            `);
        return true;
    } catch (err) {
        console.warn('Notice: Failed to insert audit log entry:', err.message);
        return false;
    }
}

/**
 * Retrieves audit log records for a document.
 */
async function getAuditLogsForDocument(documentId) {
    if (!documentId) return [];
    const p = await getPool();
    const result = await p.request()
        .input('DocumentId', sql.BigInt, Number(documentId))
        .query(`
            SELECT AuditId, EventType, DocumentId, ConflictId, ActionBy, ActionRole,
                   PreviousStatus, NewStatus, Details, CorrelationId, Timestamp
            FROM dbo.AuditLogs
            WHERE DocumentId = @DocumentId
            ORDER BY AuditId DESC
        `);
    return result.recordset;
}

/**
 * Resolves a financial document conflict in Azure SQL.
 */
async function resolveDocumentConflict({
    documentId,
    conflictId = null,
    action = 'ACCEPT_NEW',
    reviewerEmail = 'SYSTEM',
    notes = ''
}) {
    const docId = Number(documentId);
    if (!docId) throw new Error('A valid documentId is required to resolve conflict.');

    const p = await getPool();
    const resolvedStatus = action === 'ACCEPT_NEW' 
        ? 'Resolved (Accepted New)' 
        : action === 'KEEP_EXISTING'
            ? 'Resolved (Kept Existing)'
            : 'Rejected';

    const resolutionNotes = notes || (
        action === 'ACCEPT_NEW'
            ? `Accepted new figures from Document ID ${docId} as authoritative.`
            : action === 'KEEP_EXISTING'
                ? `Retained existing figures; new figures in Document ID ${docId} marked rejected.`
                : `Document ID ${docId} rejected.`
    );

    // 1. Update FactConflicts
    let conflictQuery = `
        UPDATE dbo.FactConflicts
        SET ResolutionStatus = @ResolutionStatus,
            ReviewedAt = SYSUTCDATETIME(),
            ReviewedByEmail = @ReviewerEmail,
            ResolutionNotes = @ResolutionNotes
        WHERE (FactId1 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId)
           OR FactId2 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId))
    `;
    if (conflictId) {
        conflictQuery += ' AND ConflictId = @ConflictId';
    }

    const cReq = p.request()
        .input('DocId', sql.BigInt, docId)
        .input('ResolutionStatus', sql.NVarChar(50), resolvedStatus)
        .input('ReviewerEmail', sql.NVarChar(255), reviewerEmail)
        .input('ResolutionNotes', sql.NVarChar(2000), resolutionNotes);
    if (conflictId) {
        cReq.input('ConflictId', sql.BigInt, Number(conflictId));
    }
    await cReq.query(conflictQuery);

    // 2. Update FinancialFacts validation status based on action
    if (action === 'ACCEPT_NEW') {
        await p.request()
            .input('DocId', sql.BigInt, docId)
            .query(`
                UPDATE dbo.FinancialFacts
                SET ValidationStatus = 'Validated'
                WHERE DocumentId = @DocId;

                UPDATE dbo.FinancialFacts
                SET ValidationStatus = 'Superseded'
                WHERE FactId IN (
                    SELECT CASE WHEN c.FactId1 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId) THEN c.FactId2 ELSE c.FactId1 END
                    FROM dbo.FactConflicts c
                    WHERE (c.FactId1 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId)
                       OR c.FactId2 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId))
                );

                UPDATE dbo.Documents
                SET IngestionStatus = 'Succeeded',
                    LastProcessedAt = SYSUTCDATETIME()
                WHERE DocumentId = @DocId;
            `);
    } else if (action === 'KEEP_EXISTING') {
        await p.request()
            .input('DocId', sql.BigInt, docId)
            .query(`
                UPDATE dbo.FinancialFacts
                SET ValidationStatus = 'Rejected'
                WHERE DocumentId = @DocId
                  AND FactId IN (
                      SELECT FactId1 FROM dbo.FactConflicts WHERE (FactId1 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId) OR FactId2 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId))
                      UNION
                      SELECT FactId2 FROM dbo.FactConflicts WHERE (FactId1 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId) OR FactId2 IN (SELECT FactId FROM dbo.FinancialFacts WHERE DocumentId = @DocId))
                  );

                UPDATE dbo.Documents
                SET IngestionStatus = 'Succeeded',
                    LastProcessedAt = SYSUTCDATETIME()
                WHERE DocumentId = @DocId;
            `);
    } else if (action === 'REJECT') {
        await p.request()
            .input('DocId', sql.BigInt, docId)
            .query(`
                UPDATE dbo.FinancialFacts
                SET ValidationStatus = 'Rejected'
                WHERE DocumentId = @DocId;

                UPDATE dbo.Documents
                SET IngestionStatus = 'Rejected',
                    LastProcessedAt = SYSUTCDATETIME()
                WHERE DocumentId = @DocId;
            `);
    }

    return {
        documentId: docId,
        conflictId,
        action,
        status: action === 'REJECT' ? 'Rejected' : 'Succeeded',
        reviewerEmail,
        notes: resolutionNotes
    };
}

module.exports = {
    getPool,
    setPool,
    resetPool,
    startIngestionRun,
    completeIngestionRun,
    updateIngestionRunProgress,
    createDocument,
    updateDocumentStatus,
    insertFinancialFacts,
    getDocumentById,
    getFinancialFacts,
    deleteDocumentFacts,
    insertAuditLog,
    getAuditLogsForDocument,
    resolveDocumentConflict
};

