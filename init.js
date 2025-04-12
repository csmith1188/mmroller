const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Delete existing database file if it exists
const dbPath = path.join(__dirname, 'database.db');
if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
}

// Create new database
const db = new sqlite3.Database(dbPath);

// Read and execute the SQL initialization file
const sql = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');

db.serialize(() => {
    // Drop tables if they exist
    db.run('DROP TABLE IF EXISTS match_submissions');
    db.run('DROP TABLE IF EXISTS match_players');
    db.run('DROP TABLE IF EXISTS matches');
    db.run('DROP TABLE IF EXISTS event_applications');
    db.run('DROP TABLE IF EXISTS event_participants');
    db.run('DROP TABLE IF EXISTS events');
    db.run('DROP TABLE IF EXISTS organization_members');
    db.run('DROP TABLE IF EXISTS organizations');
    db.run('DROP TABLE IF EXISTS users');

    // Create tables
    db.exec(sql, (err) => {
        if (err) {
            console.error('Error creating tables:', err);
            return;
        }
        
        console.log('Tables created successfully');
    });
});

db.close(); 