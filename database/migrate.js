const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'database.db');
const migrationsDir = path.join(__dirname, 'migrations');
const db = new sqlite3.Database(dbPath);

// Get list of migration files
const migrationFiles = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

console.log(`Found ${migrationFiles.length} migration files`);

// Execute migrations in sequence
const executeNextMigration = (index) => {
    if (index >= migrationFiles.length) {
        console.log('All migrations completed');
        db.close();
        return;
    }

    const migrationFile = migrationFiles[index];
    console.log(`Executing migration: ${migrationFile}`);

    const migrationSQL = fs.readFileSync(path.join(migrationsDir, migrationFile), 'utf8');

    db.serialize(() => {
        db.run('BEGIN TRANSACTION');

        // Execute migration SQL
        db.exec(migrationSQL, (err) => {
            if (err) {
                console.error(`Error executing migration ${migrationFile}:`, err);
                db.run('ROLLBACK');
                db.close();
                process.exit(1);
            }

            db.run('COMMIT', (err) => {
                if (err) {
                    console.error(`Error committing migration ${migrationFile}:`, err);
                    db.run('ROLLBACK');
                    db.close();
                    process.exit(1);
                }

                console.log(`Completed migration: ${migrationFile}`);
                executeNextMigration(index + 1);
            });
        });
    });
};

// Start executing migrations
executeNextMigration(0); 