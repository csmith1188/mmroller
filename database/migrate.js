const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

// Database path
const dbPath = path.join(__dirname, 'database.db');
const migrationsDir = path.join(__dirname, 'migrations');

// Create database connection
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
    console.log('Database opened successfully');
});

// Get list of migration files
fs.readdir(migrationsDir, (err, files) => {
    if (err) {
        console.error('Error reading migrations directory:', err);
        db.close();
        process.exit(1);
    }

    // Filter and sort SQL files
    const migrationFiles = files
        .filter(file => file.endsWith('.sql'))
        .sort();

    // Execute migrations in sequence
    const executeMigrations = (index) => {
        if (index >= migrationFiles.length) {
            console.log('All migrations completed');
            db.close();
            return;
        }

        const file = migrationFiles[index];
        console.log(`Executing migration: ${file}`);
        
        // Read and execute migration file
        const migrationPath = path.join(migrationsDir, file);
        const sql = fs.readFileSync(migrationPath, 'utf8');

        db.serialize(() => {
            db.run('BEGIN TRANSACTION');

            // Execute migration SQL
            db.exec(sql, (err) => {
                if (err) {
                    console.error(`Error executing migration ${file}:`, err);
                    db.run('ROLLBACK');
                    db.close();
                    process.exit(1);
                }

                db.run('COMMIT');
                console.log(`Successfully executed migration: ${file}`);
                executeMigrations(index + 1);
            });
        });
    };

    // Start executing migrations
    executeMigrations(0);
}); 