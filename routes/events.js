const express = require('express');
const router = express.Router();

// Event routes
router.get('/events/:id', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;
    
    // Get event details with organization info and participant status
    db.get(`
        SELECT e.*, 
               o.name as organization_name,
               CASE WHEN ep.user_id IS NOT NULL THEN 1 ELSE 0 END as is_participant,
               CASE WHEN o.admin_id = ? THEN 1 ELSE 0 END as is_admin
        FROM events e
        JOIN organizations o ON e.organization_id = o.id
        LEFT JOIN event_participants ep ON e.id = ep.event_id AND ep.user_id = ?
        WHERE e.id = ?
    `, [userId, userId, eventId], (err, event) => {
        if (err || !event) {
            console.error(err);
            return res.status(404).send('Event not found');
        }
        
        // Get event participants
        db.all(`
            SELECT u.id, u.username
            FROM users u
            JOIN event_participants ep ON u.id = ep.user_id
            WHERE ep.event_id = ?
        `, [eventId], (err, participants) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error fetching participants');
            }
            
            // Get event matches with player information
            db.all(`
                SELECT m.*, 
                       GROUP_CONCAT(u.username) as player_names,
                       GROUP_CONCAT(u.id) as player_ids,
                       GROUP_CONCAT(mp.position) as positions,
                       GROUP_CONCAT(mp.final_score) as final_scores
                FROM matches m
                JOIN match_players mp ON m.id = mp.match_id
                JOIN users u ON mp.user_id = u.id
                WHERE m.event_id = ?
                GROUP BY m.id
                ORDER BY m.created_at DESC
            `, [eventId], (err, matches) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Error fetching matches');
                }

                // Process the matches to create a more usable format
                const processedMatches = matches.map(match => {
                    const playerNames = match.player_names.split(',');
                    const playerIds = match.player_ids.split(',').map(Number);
                    const positions = match.positions.split(',').map(Number);
                    const finalScores = match.final_scores ? match.final_scores.split(',').map(Number) : Array(playerNames.length).fill(null);

                    const players = playerNames.map((name, i) => ({
                        id: playerIds[i],
                        username: name,
                        position: positions[i],
                        final_score: finalScores[i]
                    })).sort((a, b) => a.position - b.position);

                    return {
                        ...match,
                        players,
                        player_names: undefined,
                        player_ids: undefined,
                        positions: undefined,
                        final_scores: undefined
                    };
                });
                
                // Get event applications if user is admin
                if (event.is_admin) {
                    db.all(`
                        SELECT ea.*, u.username
                        FROM event_applications ea
                        JOIN users u ON ea.user_id = u.id
                        WHERE ea.event_id = ?
                        ORDER BY ea.applied_at DESC
                    `, [eventId], (err, applications) => {
                        if (err) {
                            console.error(err);
                            return res.status(500).send('Error fetching applications');
                        }
                        
                        res.render('event', {
                            event,
                            participants,
                            matches: processedMatches,
                            applications,
                            userId
                        });
                    });
                } else {
                    res.render('event', {
                        event,
                        participants,
                        matches: processedMatches,
                        applications: [],
                        userId
                    });
                }
            });
        });
    });
});

// Event application route
router.post('/events/:id/apply', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;
    
    // Check if user is already a participant
    db.get(`
        SELECT 1 FROM event_participants
        WHERE event_id = ? AND user_id = ?
    `, [eventId, userId], (err, isParticipant) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error checking participant status');
        }
        
        if (isParticipant) {
            return res.status(400).send('You are already a participant in this event');
        }
        
        // Check if user has already applied
        db.get(`
            SELECT 1 FROM event_applications
            WHERE event_id = ? AND user_id = ?
        `, [eventId, userId], (err, hasApplied) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error checking application status');
            }
            
            if (hasApplied) {
                return res.status(400).send('You have already applied to this event');
            }
            
            // Create application
            db.run(`
                INSERT INTO event_applications (event_id, user_id, applied_at)
                VALUES (?, ?, datetime('now'))
            `, [eventId, userId], (err) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Error submitting application');
                }
                
                res.redirect(`/events/${eventId}`);
            });
        });
    });
});

// Accept event application route
router.post('/events/:id/accept/:userId', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const adminId = req.session.userId;
    
    // Verify user is admin of the organization
    db.get(`
        SELECT 1 FROM events e
        JOIN organizations o ON e.organization_id = o.id
        WHERE e.id = ? AND o.admin_id = ?
    `, [eventId, adminId], (err, isAdmin) => {
        if (err || !isAdmin) {
            return res.status(403).send('Unauthorized');
        }
        
        // Start transaction
        db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error starting transaction');
            }
            
            // Add user as participant
            db.run(`
                INSERT INTO event_participants (event_id, user_id)
                VALUES (?, ?)
            `, [eventId, userId], (err) => {
                if (err) {
                    db.run('ROLLBACK');
                    console.error(err);
                    return res.status(500).send('Error adding participant');
                }
                
                // Remove application
                db.run(`
                    DELETE FROM event_applications
                    WHERE event_id = ? AND user_id = ?
                `, [eventId, userId], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        console.error(err);
                        return res.status(500).send('Error removing application');
                    }
                    
                    // Commit transaction
                    db.run('COMMIT', (err) => {
                        if (err) {
                            console.error(err);
                            return res.status(500).send('Error committing transaction');
                        }
                        
                        res.redirect(`/events/${eventId}`);
                    });
                });
            });
        });
    });
});

// Reject event application
router.post('/events/:id/reject/:userId', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const currentUserId = req.session.userId;

    // Verify user is admin of the organization
    db.get(`
        SELECT 1 FROM events e
        JOIN organizations o ON e.organization_id = o.id
        WHERE e.id = ? AND o.admin_id = ?
    `, [eventId, currentUserId], (err, isAdmin) => {
        if (err || !isAdmin) {
            return res.status(403).send('Unauthorized');
        }

        // Delete the application
        db.run(`
            DELETE FROM event_applications
            WHERE event_id = ? AND user_id = ?
        `, [eventId, userId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error rejecting application');
            }

            res.redirect(`/events/${eventId}`);
        });
    });
});

// Create new event route
router.get('/organizations/:id/events/new', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    res.render('new-event', { organizationId: req.params.id });
});

router.post('/organizations/:id/events', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const { name, description, start_date, end_date } = req.body;
    const userId = req.session.userId;
    
    // Verify user is admin of organization
    db.get(`
        SELECT 1 FROM organizations 
        WHERE id = ? AND admin_id = ?
    `, [orgId, userId], (err, result) => {
        if (err || !result) {
            return res.status(403).send('Unauthorized: Only organization admins can create events');
        }
        
        // Start transaction
        db.run('BEGIN TRANSACTION', (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error starting transaction');
            }
            
            // Create event
            db.run(`
                INSERT INTO events (name, description, organization_id, start_date, end_date)
                VALUES (?, ?, ?, ?, ?)
            `, [name, description, orgId, start_date, end_date], function(err) {
                if (err) {
                    db.run('ROLLBACK');
                    return res.status(500).send('Error creating event');
                }
                
                const eventId = this.lastID;
                
                // Add admin as participant
                db.run(`
                    INSERT INTO event_participants (event_id, user_id)
                    VALUES (?, ?)
                `, [eventId, userId], (err) => {
                    if (err) {
                        db.run('ROLLBACK');
                        console.error(err);
                        return res.status(500).send('Error adding admin as participant');
                    }
                    
                    // Commit transaction
                    db.run('COMMIT', (err) => {
                        if (err) {
                            console.error(err);
                            return res.status(500).send('Error committing transaction');
                        }
                        
                        res.redirect(`/organizations/${orgId}`);
                    });
                });
            });
        });
    });
});

// Search players for event
router.get('/events/:id/search-players', (req, res) => {
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const query = req.query.q;
    
    if (!query || query.length < 2) {
        return res.json([]);
    }
    
    // Search for participants in the event
    db.all(`
        SELECT u.id, u.username
        FROM users u
        JOIN event_participants ep ON u.id = ep.user_id
        WHERE ep.event_id = ? AND u.username LIKE ?
        ORDER BY u.username
        LIMIT 10
    `, [eventId, `%${query}%`], (err, players) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error searching players');
        }
        
        res.json(players);
    });
});

// Toggle event visibility
router.post('/events/:id/toggle-visibility', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;

    // Verify user is admin of the organization
    db.get(`
        SELECT 1 FROM events e
        JOIN organizations o ON e.organization_id = o.id
        WHERE e.id = ? AND o.admin_id = ?
    `, [eventId, userId], (err, isAdmin) => {
        if (err || !isAdmin) {
            return res.status(403).send('Unauthorized');
        }

        // Toggle the hidden status
        db.run(`
            UPDATE events
            SET hidden = CASE WHEN hidden = 1 THEN 0 ELSE 1 END
            WHERE id = ?
        `, [eventId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error toggling event visibility');
            }

            res.redirect(`/events/${eventId}`);
        });
    });
});

// Toggle scoring system
router.post('/events/:id/toggle-scoring', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;

    // Verify user is admin
    db.get(`
        SELECT e.*, o.admin_id 
        FROM events e
        JOIN organizations o ON e.organization_id = o.id
        WHERE e.id = ? AND o.admin_id = ?
    `, [eventId, userId], (err, event) => {
        if (err || !event) {
            return res.status(403).send('Unauthorized');
        }

        // Toggle the lowest_score_wins value
        db.run(`
            UPDATE events
            SET lowest_score_wins = CASE WHEN lowest_score_wins = 0 THEN 1 ELSE 0 END
            WHERE id = ?
        `, [eventId], (err) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error updating scoring system');
            }
            res.redirect(`/events/${eventId}`);
        });
    });
});

module.exports = router; 