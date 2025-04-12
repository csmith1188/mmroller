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
        
        // Verify events table structure
        db.all("PRAGMA table_info(events)", (err, columns) => {
            if (err) {
                console.error('Error getting table info:', err);
                return;
            }
            
            console.log('Events table columns:', columns.map(col => col.name).join(', '));
            
            // Create test data
            db.run("INSERT OR IGNORE INTO users (username, password_hash) VALUES (?, ?)", 
                ['admin', '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDdWoXehVzJptJ/op0lSsvqNu.Vm'], function(err) {
                    if (err) {
                        console.error('Error creating admin user:', err);
                        return;
                    }
                    
                    const adminId = this.lastID;
                    
                    // Create test organization
                    db.run(`
                        INSERT OR IGNORE INTO organizations (name, description, created_by)
                        VALUES (?, ?, ?)
                    `, ['Test Organization', 'A test organization', adminId], function(err) {
                        if (err) {
                            console.error('Error creating test organization:', err);
                            return;
                        }

                        const orgId = this.lastID;

                        // Add admin as member
                        db.run(`
                            INSERT OR IGNORE INTO organization_members (organization_id, user_id)
                            VALUES (?, ?)
                        `, [orgId, adminId], function(err) {
                            if (err) {
                                console.error('Error adding admin to organization:', err);
                                return;
                            }

                            // Add admin as admin
                            db.run(`
                                INSERT OR IGNORE INTO organization_admins (organization_id, user_id)
                                VALUES (?, ?)
                            `, [orgId, adminId], function(err) {
                                if (err) {
                                    console.error('Error adding admin as admin:', err);
                                    return;
                                }

                                // Create test event
                                db.run(`
                                    INSERT OR IGNORE INTO events (name, description, organization_id, start_date, end_date, hidden)
                                    VALUES (?, ?, ?, datetime('now'), datetime('now', '+1 day'), 0)
                                `, ['Test Event', 'A test event', orgId], function(err) {
                                    if (err) {
                                        console.error('Error creating test event:', err);
                                        return;
                                    }

                                    const eventId = this.lastID;

                                    // Add admin as participant
                                    db.run(`
                                        INSERT OR IGNORE INTO event_participants (event_id, user_id)
                                        VALUES (?, ?)
                                    `, [eventId, adminId], function(err) {
                                        if (err) {
                                            console.error('Error adding admin to event:', err);
                                            return;
                                        }

                                        // Create test match
                                        db.run(`
                                            INSERT OR IGNORE INTO matches (event_id, status)
                                            VALUES (?, ?)
                                        `, [eventId, 'pending'], function(err) {
                                            if (err) {
                                                console.error('Error creating test match:', err);
                                                return;
                                            }

                                            const matchId = this.lastID;

                                            // Add admin as player
                                            db.run(`
                                                INSERT OR IGNORE INTO match_players (match_id, user_id, position)
                                                VALUES (?, ?, ?)
                                            `, [matchId, adminId, 1], function(err) {
                                                if (err) {
                                                    console.error('Error adding admin to match:', err);
                                                    return;
                                                }

                                                // Create test match submission
                                                db.run(`
                                                    INSERT OR IGNORE INTO match_submissions (match_id, user_id, scores)
                                                    VALUES (?, ?, ?)
                                                `, [matchId, adminId, JSON.stringify({ [adminId]: 100 })], function(err) {
                                                    if (err) {
                                                        console.error('Error creating test submission:', err);
                                                        return;
                                                    }
                                                    
                                                    console.log('Test data created successfully');
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
        });
    });
});

db.close(); 