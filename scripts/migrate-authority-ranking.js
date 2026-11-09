require('../src/utils/config');
const { getPool } = require('../src/services/sql');

/**
 * Standalone Migration Script: Authority Ranking & Employee Details (Phase 1)
 * 
 * Safely applies the repeatable migration to Azure SQL:
 * 1. Enhances dbo.AuthorityRank with NormalizedJobTitle, NormalizedDepartment, UpdatedAt.
 * 2. Populates normalized fields for existing records.
 * 3. Applies unique index on (NormalizedJobTitle, NormalizedDepartment) if clean.
 * 4. Seeds sample authority mappings if table is empty.
 * 5. Creates dbo.EmployeeDetails with appropriate indexes.
 */
async function runMigration() {
    console.log('[Migration] Connecting to Azure SQL Database and initializing schema...');
    try {
        const pool = await getPool();
        console.log('[Migration] Database schema migration successfully verified and initialized.');
        
        // Inspect current counts
        const rankCount = await pool.request().query('SELECT COUNT(*) AS total FROM dbo.AuthorityRank');
        const empCount = await pool.request().query('SELECT COUNT(*) AS total FROM dbo.EmployeeDetails');
        
        console.log(`[Migration] dbo.AuthorityRank rows: ${rankCount.recordset[0].total}`);
        console.log(`[Migration] dbo.EmployeeDetails rows: ${empCount.recordset[0].total}`);
        process.exitCode = 0;
    } catch (err) {
        console.error('[Migration] Migration failed:', err.message);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runMigration();
}

module.exports = { runMigration };

