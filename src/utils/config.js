const path = require('path');
const fs = require('fs');
require('dotenv').config();

// Auto-load local.settings.json in development environments
if (!process.env.AZURE_SQL_SERVER) {
    const localSettingsPath = path.resolve(__dirname, '../../local.settings.json');
    if (fs.existsSync(localSettingsPath)) {
        try {
            const raw = fs.readFileSync(localSettingsPath, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed.Values) {
                for (const [key, val] of Object.entries(parsed.Values)) {
                    if (!process.env[key]) {
                        process.env[key] = String(val);
                    }
                }
            }
        } catch (_) {}
    }
}

module.exports = process.env;
