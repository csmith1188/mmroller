const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Get the absolute path to the database directory
const dbDir = path.resolve(__dirname);
console.log('Database directory:', dbDir);

// Ensure database directory exists
if (!fs.existsSync(dbDir)) {
    console.log('Creating database directory...');
    fs.mkdirSync(dbDir, { recursive: true });
}

// Database path
const dbPath = path.join(dbDir, 'database.db');
console.log('Database path:', dbPath);

// SQL file path
const sqlPath = path.join(dbDir, 'init.sql');
console.log('SQL file path:', sqlPath);

// Verify SQL file exists
if (!fs.existsSync(sqlPath)) {
    console.error('SQL initialization file not found:', sqlPath);
    process.exit(1);
}

// Delete existing database file if it exists
if (fs.existsSync(dbPath)) {
    console.log('Deleting existing database file...');
    fs.unlinkSync(dbPath);
}

// Create new database
console.log('Creating new database...');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error creating database:', err);
        process.exit(1);
    }
    console.log('Database created successfully');
});

// Read and execute the SQL initialization file
console.log('Reading SQL file...');
const sql = fs.readFileSync(sqlPath, 'utf8');

db.serialize(() => {
    console.log('Dropping existing tables...');
    // Drop tables if they exist
    db.run('DROP TABLE IF EXISTS match_submissions');
    db.run('DROP TABLE IF EXISTS match_players');
    db.run('DROP TABLE IF EXISTS matches');
    db.run('DROP TABLE IF EXISTS event_applications');
    db.run('DROP TABLE IF EXISTS event_participants');
    db.run('DROP TABLE IF EXISTS events');
    db.run('DROP TABLE IF EXISTS organization_members');
    db.run('DROP TABLE IF EXISTS organization_admins');
    db.run('DROP TABLE IF EXISTS organization_bans');
    db.run('DROP TABLE IF EXISTS organizations');
    db.run('DROP TABLE IF EXISTS users');
    db.run('DROP TABLE IF EXISTS sessions');

    console.log('Creating tables...');
    // Create tables
    db.exec(sql, (err) => {
        if (err) {
            console.error('Error creating tables:', err);
            db.close();
            process.exit(1);
        }
        console.log('Tables created successfully');
        db.close();
    });
}); 