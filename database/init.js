const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'database.sqlite');

// Delete existing database file if it exists
if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
}

// Create new database
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error creating database:', err);
        return;
    }
    console.log('Connected to the SQLite database.');
});

// Read and execute SQL schema
const schema = fs.readFileSync(path.join(__dirname, 'init.sql'), 'utf8');

db.serialize(() => {
    db.exec(schema, (err) => {
        if (err) {
            console.error('Error executing schema:', err);
            return;
        }
        console.log('Database schema created successfully.');
    });
});

// Close the database connection
db.close((err) => {
    if (err) {
        console.error('Error closing database:', err);
        return;
    }
    console.log('Database connection closed.');
}); 