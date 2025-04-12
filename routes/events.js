const express = require('express');
const router = express.Router();
const matchRoutes = require('./matches');

// Mount matches routes
router.use('/:id/matches', matchRoutes);

// Event routes
router.get('/:id', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;
    
    // Get event details with organization info and participant status
    db.get(`
        SELECT e.*, 
               o.name as organization_name,
               o.id as organization_id,
               CASE WHEN ep.user_id IS NOT NULL THEN 1 ELSE 0 END as is_participant,
               CASE WHEN EXISTS (
                   SELECT 1 FROM organization_admins 
                   WHERE organization_id = o.id AND user_id = ?
               ) THEN 1 ELSE 0 END as is_admin
        FROM events e
        JOIN organizations o ON e.organization_id = o.id
        LEFT JOIN event_participants ep ON e.id = ep.event_id AND ep.user_id = ?
        WHERE e.id = ?
    `, [userId, userId, eventId], (err, event) => {
        if (err || !event) {
            console.error(err);
            return res.status(404).send('Event not found');
        }

        // Check if user is banned from the organization
        db.get(`
            SELECT 1 FROM organization_bans
            WHERE organization_id = ? AND user_id = ? AND status = 'active'
        `, [event.organization_id, userId], (err, isOrgBanned) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error checking organization ban status');
            }

            if (isOrgBanned && !event.is_admin) {
                return res.status(403).send('You are banned from this organization');
            }

            // Check if user is banned from the event
            db.get(`
                SELECT 1 FROM event_bans
                WHERE event_id = ? AND user_id = ? AND status = 'active'
            `, [eventId, userId], (err, isEventBanned) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Error checking event ban status');
                }

                if (isEventBanned && !event.is_admin) {
                    return res.status(403).send('You are banned from this event');
                }
            
                // Get event participants
                db.all(`
                    SELECT u.id, u.username,
                           pes.mmr, pes.matches_played, pes.wins, pes.losses,
                           CASE WHEN o.created_by = u.id THEN 1 ELSE 0 END as is_creator,
                           CASE WHEN eb.status = 'active' THEN 1 ELSE 0 END as is_banned
                    FROM users u
                    JOIN event_participants ep ON u.id = ep.user_id
                    LEFT JOIN player_event_stats pes ON pes.event_id = ep.event_id AND pes.user_id = u.id
                    JOIN events e ON e.id = ep.event_id
                    JOIN organizations o ON o.id = e.organization_id
                    LEFT JOIN event_bans eb ON eb.event_id = e.id AND eb.user_id = u.id
                    WHERE ep.event_id = ?
                    AND (? = 1 OR NOT EXISTS (
                        SELECT 1 FROM event_bans 
                        WHERE event_id = e.id AND user_id = u.id AND status = 'active'
                    ))
                    ORDER BY pes.mmr DESC NULLS LAST
                `, [eventId, event.is_admin], (err, participants) => {
                    if (err) {
                        console.error(err);
                        return res.status(500).send('Error fetching participants');
                    }
                    
                    // Format stats for display
                    const participantsWithStats = participants.map(participant => ({
                        ...participant,
                        mmr: participant.mmr || 1500,
                        matches_played: participant.matches_played || 0,
                        wins: participant.wins || 0,
                        losses: participant.losses || 0
                    }));
                    
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
                        
                        // Process matches to split concatenated fields
                        const processedMatches = matches.map(match => ({
                            ...match,
                            player_names: match.player_names ? match.player_names.split(',') : [],
                            player_ids: match.player_ids ? match.player_ids.split(',').map(Number) : [],
                            positions: match.positions ? match.positions.split(',').map(Number) : [],
                            final_scores: match.final_scores ? match.final_scores.split(',').map(Number) : []
                        }));
                        
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
                                    participants: participantsWithStats,
                                    matches: processedMatches,
                                    applications,
                                    userId,
                                    isAdmin: event.is_admin
                                });
                            });
                        } else {
                            res.render('event', {
                                event,
                                participants: participantsWithStats,
                                matches: processedMatches,
                                applications: [],
                                userId,
                                isAdmin: event.is_admin
                            });
                        }
                    });
                });
            });
        });
    });
});

// Get match details
router.get('/:id/matches/:matchId', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.matchId;
    const userId = req.session.userId;
    
    // Get match details with players and event info
    db.get(`
        SELECT m.*, e.name as event_name, e.organization_id,
               CASE WHEN EXISTS (
                   SELECT 1 FROM organization_admins oa
                   WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
               ) THEN 1 ELSE 0 END as is_admin
        FROM matches m
        JOIN events e ON m.event_id = e.id
        WHERE m.id = ?
    `, [userId, matchId], (err, match) => {
        if (err) {
            console.error('Error fetching match:', err);
            return res.status(500).send('Error fetching match details');
        }
        
        if (!match) {
            return res.status(404).send('Match not found');
        }
        
        // Get match players
        db.all(`
            SELECT mp.*, u.username
            FROM match_players mp
            JOIN users u ON mp.user_id = u.id
            WHERE mp.match_id = ?
            ORDER BY mp.position
        `, [matchId], (err, players) => {
            if (err) {
                console.error('Error fetching match players:', err);
                return res.status(500).send('Error fetching match players');
            }
            
            // Add players to match object
            match.players = players;
            
            // Get match submissions
            db.all(`
                SELECT ms.*, u.username
                FROM match_submissions ms
                JOIN users u ON ms.user_id = u.id
                WHERE ms.match_id = ?
                ORDER BY ms.submitted_at DESC
            `, [matchId], (err, submissions) => {
                if (err) {
                    console.error('Error fetching match submissions:', err);
                    return res.status(500).send('Error fetching match submissions');
                }
                
                // Add submissions to match object
                match.submissions = submissions;
                
                res.render('match', {
                    match,
                    isAdmin: match.is_admin,
                    userId
                });
            });
        });
    });
});

// Event application route
router.post('/:id/apply', (req, res) => {
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

// Accept event application
router.post('/:id/accept/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const currentUserId = req.session.userId;

    try {
        // Verify user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM events e
                JOIN organizations o ON e.organization_id = o.id
                JOIN organization_admins oa ON o.id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, currentUserId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Add user as participant
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO event_participants (event_id, user_id) VALUES (?, ?)',
                    [eventId, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Check if player stats already exist
            const statsExist = await new Promise((resolve, reject) => {
                db.get(
                    'SELECT 1 FROM player_event_stats WHERE event_id = ? AND user_id = ?',
                    [eventId, userId],
                    (err, row) => {
                        if (err) reject(err);
                        resolve(!!row);
                    }
                );
            });

            // Initialize player stats if they don't exist
            if (!statsExist) {
                await new Promise((resolve, reject) => {
                    db.run(
                        'INSERT INTO player_event_stats (event_id, user_id, mmr) VALUES (?, ?, ?)',
                        [eventId, userId, 1500],
                        (err) => {
                            if (err) reject(err);
                            resolve();
                        }
                    );
                });
            }

            // Remove application
            await new Promise((resolve, reject) => {
                db.run(
                    'DELETE FROM event_applications WHERE event_id = ? AND user_id = ?',
                    [eventId, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/events/${eventId}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error accepting application:', error);
        res.status(500).send('Error accepting application');
    }
});

// Reject event application
router.post('/:id/reject/:userId', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const currentUserId = req.session.userId;

    // Verify user is admin of the organization
    db.get(`
        SELECT e.*, e.organization_id
        FROM events e
        WHERE e.id = ? AND EXISTS (
            SELECT 1 FROM organization_admins oa
            WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
        )
    `, [eventId, currentUserId], (err, event) => {
        if (err || !event) {
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
router.get('/organizations/:id/new', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    res.render('new-event', { organizationId: req.params.id });
});

// Create a new event
router.post('/organizations/:id', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const orgId = req.params.id;
    const { name, description, start_date, end_date, hidden, lowest_score_wins } = req.body;
    const userId = req.session.userId;

    if (!userId) {
        return res.status(401).send('You must be logged in to create an event');
    }

    try {
        // Check if user is an admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(
                'SELECT 1 FROM organization_admins WHERE organization_id = ? AND user_id = ?',
                [orgId, userId],
                (err, row) => {
                    if (err) reject(err);
                    resolve(!!row);
                }
            );
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can create events');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Create event
            const eventId = await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO events (name, description, organization_id, start_date, end_date, hidden, lowest_score_wins) VALUES (?, ?, ?, ?, ?, ?, ?)',
                    [name, description, orgId, start_date, end_date, hidden ? 1 : 0, lowest_score_wins ? 1 : 0],
                    function(err) {
                        if (err) reject(err);
                        resolve(this.lastID);
                    }
                );
            });

            // Add admin as participant
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO event_participants (event_id, user_id) VALUES (?, ?)',
                    [eventId, userId],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Initialize admin's stats
            await new Promise((resolve, reject) => {
                db.run(
                    'INSERT INTO player_event_stats (event_id, user_id, mmr) VALUES (?, ?, ?)',
                    [eventId, userId, 1500],
                    (err) => {
                        if (err) reject(err);
                        resolve();
                    }
                );
            });

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/events/${eventId}`);
        } catch (error) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw error;
        }
    } catch (error) {
        console.error('Error creating event:', error);
        res.status(500).send('Error creating event');
    }
});

// Search players for event
router.get('/:id/search-players', (req, res) => {
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
router.post('/:id/toggle-visibility', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;

    // Verify user is admin of the organization
    db.get(`
        SELECT e.*, e.organization_id
        FROM events e
        WHERE e.id = ? AND EXISTS (
            SELECT 1 FROM organization_admins oa
            WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
        )
    `, [eventId, userId], (err, event) => {
        if (err || !event) {
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
router.post('/:id/toggle-scoring', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.user.id;

    // Verify user is admin
    db.get(`
        SELECT e.*, e.organization_id
        FROM events e
        WHERE e.id = ? AND EXISTS (
            SELECT 1 FROM organization_admins oa
            WHERE oa.organization_id = e.organization_id AND oa.user_id = ?
        )
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
                console.error('Error updating scoring system:', err);
                return res.status(500).send('Error updating scoring system');
            }
            res.redirect(`/events/${eventId}`);
        });
    });
});

// Kick participant from event
router.post('/:id/kick/:userId', async (req, res) => {
    // ... rest of the route handler ...
});

// Ban participant from event
router.post('/:id/ban/:userId', async (req, res) => {
    // ... rest of the route handler ...
});

// Unban participant from event
router.post('/:id/unban/:userId', async (req, res) => {
    // ... rest of the route handler ...
});

// Update event
router.post('/:id/update', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const { name, description } = req.body;
    const userId = req.user.id;

    // Check if user is admin of the organization
    db.get(`
        SELECT 1 FROM organization_admins oa
        JOIN events e ON e.organization_id = oa.organization_id
        WHERE e.id = ? AND oa.user_id = ?
    `, [eventId, userId], (err, isAdmin) => {
        if (err) {
            console.error('Error checking admin status:', err);
            return res.status(500).send('Error checking admin status');
        }

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can update events');
        }

        // Update event
        db.run(`
            UPDATE events
            SET name = ?, description = ?
            WHERE id = ?
        `, [name, description, eventId], (err) => {
            if (err) {
                console.error('Error updating event:', err);
                return res.status(500).send('Error updating event');
            }

            res.redirect(`/events/${eventId}`);
        });
    });
});

// Create new match route
router.get('/:id/matches/new', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can create matches');
        }

        // Get event participants
        const participants = await new Promise((resolve, reject) => {
            db.all(`
                SELECT u.id, u.username, pes.mmr
                FROM users u
                JOIN event_participants ep ON u.id = ep.user_id
                LEFT JOIN player_event_stats pes ON pes.event_id = ep.event_id AND pes.user_id = u.id
                WHERE ep.event_id = ?
                ORDER BY u.username
            `, [eventId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        res.render('new-match', { eventId, participants });
    } catch (error) {
        console.error('Error accessing new match form:', error);
        res.status(500).send('Error accessing new match form');
    }
});

// Create match route
router.post('/:id/matches', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;
    
    // Get all player IDs from the form
    const playerIds = Object.entries(req.body)
        .filter(([key]) => key.startsWith('player') && key.endsWith('_id'))
        .map(([_, value]) => value);

    // Validate input
    if (playerIds.length < 2) {
        return res.status(400).send('At least two players are required');
    }

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can create matches');
        }

        // Verify players are event participants
        const areParticipants = await new Promise((resolve, reject) => {
            const placeholders = playerIds.map(() => '?').join(',');
            db.get(`
                SELECT COUNT(*) as count
                FROM event_participants
                WHERE event_id = ? AND user_id IN (${placeholders})
            `, [eventId, ...playerIds], (err, row) => {
                if (err) reject(err);
                resolve(row.count === playerIds.length);
            });
        });

        if (!areParticipants) {
            return res.status(400).send('All players must be event participants');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Create match
            const matchId = await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO matches (event_id, status)
                    VALUES (?, 'pending')
                `, [eventId], function(err) {
                    if (err) reject(err);
                    resolve(this.lastID);
                });
            });

            // Add players to match
            const playerInserts = playerIds.map((playerId, index) => {
                return new Promise((resolve, reject) => {
                    db.run(`
                        INSERT INTO match_players (match_id, user_id, position)
                        VALUES (?, ?, ?)
                    `, [matchId, playerId, index + 1], (err) => {
                        if (err) reject(err);
                        resolve();
                    });
                });
            });

            await Promise.all(playerInserts);

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/events/${eventId}`);
        } catch (err) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw err;
        }
    } catch (err) {
        console.error(err);
        res.status(500).send('Error creating match');
    }
});

// Submit match scores
router.post('/:id/matches/:matchId/scores', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const matchId = req.params.matchId;
    const userId = req.session.userId;
    const scores = req.body.scores;

    try {
        // Verify user is a player in the match
        const isPlayer = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM match_players
                WHERE match_id = ? AND user_id = ?
            `, [matchId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isPlayer) {
            return res.status(403).send('Unauthorized: You are not a player in this match');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Delete any existing submission by this user
            await new Promise((resolve, reject) => {
                db.run(`
                    DELETE FROM match_submissions
                    WHERE match_id = ? AND user_id = ?
                `, [matchId, userId], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            // Create new submission
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO match_submissions (match_id, user_id, scores)
                    VALUES (?, ?, ?)
                `, [matchId, userId, JSON.stringify(scores)], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            // Commit transaction
            await new Promise((resolve, reject) => {
                db.run('COMMIT', (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            res.redirect(`/events/${req.params.id}/matches/${matchId}`);
        } catch (err) {
            // Rollback transaction on error
            await new Promise((resolve) => {
                db.run('ROLLBACK', () => resolve());
            });
            throw err;
        }
    } catch (err) {
        console.error('Error submitting scores:', err);
        res.status(500).send('Error submitting scores');
    }
});

module.exports = router;