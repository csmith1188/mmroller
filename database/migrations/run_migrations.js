const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Get the database path from environment variable or use default
const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'database.sqlite');

// Create database connection
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
    console.log('Connected to the database');
});

// Read the combined migrations file
const migrationsPath = path.join(__dirname, 'combined_migrations.sql');
const migrations = fs.readFileSync(migrationsPath, 'utf8');

// Split the migrations into individual statements
const statements = migrations
    .split(';')
    .map(statement => statement.trim())
    .filter(statement => statement.length > 0);

// Execute each statement
db.serialize(() => {
    db.run('BEGIN TRANSACTION;');

    statements.forEach((statement, index) => {
        console.log(`Executing statement ${index + 1}/${statements.length}`);
        db.run(statement + ';', (err) => {
            if (err) {
                console.error(`Error executing statement ${index + 1}:`, err);
                console.error('Statement:', statement);
                process.exit(1);
            }
        });
    });

    db.run('COMMIT;', (err) => {
        if (err) {
            console.error('Error committing transaction:', err);
            process.exit(1);
        }
        console.log('All migrations completed successfully');
        db.close();
    });
}); 