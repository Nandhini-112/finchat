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
        CreatedAt DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()
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
