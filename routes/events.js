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
                                    userId
                                });
                            });
                        } else {
                            res.render('event', {
                                event,
                                participants: participantsWithStats,
                                matches: processedMatches,
                                applications: [],
                                userId
                            });
                        }
                    });
                });
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

// Accept event application
router.post('/events/:id/accept/:userId', async (req, res) => {
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
router.post('/events/:id/reject/:userId', (req, res) => {
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
router.get('/organizations/:id/events/new', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    res.render('new-event', { organizationId: req.params.id });
});

// Create a new event
router.post('/organizations/:id/events', async (req, res) => {
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
router.post('/events/:id/toggle-scoring', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.session.userId;

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
                console.error(err);
                return res.status(500).send('Error updating scoring system');
            }
            res.redirect(`/events/${eventId}`);
        });
    });
});

// Kick participant from event
router.post('/events/:id/kick/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const adminId = req.session.userId;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, adminId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can kick participants');
        }

        // Check if target user is the organization creator
        const isCreator = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organizations o
                JOIN events e ON e.organization_id = o.id
                WHERE e.id = ? AND o.created_by = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (isCreator) {
            return res.status(403).send('Cannot kick the organization creator');
        }

        // Start transaction
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        try {
            // Mark participant's matches as forfeit
            await new Promise((resolve, reject) => {
                db.run(`
                    UPDATE matches 
                    SET status = 'forfeit'
                    WHERE event_id = ? AND id IN (
                        SELECT match_id FROM match_players 
                        WHERE user_id = ?
                    )
                `, [eventId, userId], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });

            // Remove participant from event
            await new Promise((resolve, reject) => {
                db.run(`
                    DELETE FROM event_participants 
                    WHERE event_id = ? AND user_id = ?
                `, [eventId, userId], (err) => {
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
        res.status(500).send('Error kicking participant');
    }
});

// Ban participant from event
router.post('/events/:id/ban/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const adminId = req.session.userId;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, adminId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can ban participants');
        }

        // Check if target user is the organization creator
        const isCreator = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organizations o
                JOIN events e ON e.organization_id = o.id
                WHERE e.id = ? AND o.created_by = ?
            `, [eventId, userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (isCreator) {
            return res.status(403).send('Cannot ban the organization creator');
        }

        // Add ban record
        await new Promise((resolve, reject) => {
            db.run(`
                INSERT OR REPLACE INTO event_bans (event_id, user_id, status)
                VALUES (?, ?, 'active')
            `, [eventId, userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.redirect(`/events/${eventId}`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error banning participant');
    }
});

// Unban participant from event
router.post('/events/:id/unban/:userId', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const eventId = req.params.id;
    const userId = req.params.userId;
    const adminId = req.session.userId;

    try {
        // Check if user is admin of the organization
        const isAdmin = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 1 FROM organization_admins oa
                JOIN events e ON e.organization_id = oa.organization_id
                WHERE e.id = ? AND oa.user_id = ?
            `, [eventId, adminId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });

        if (!isAdmin) {
            return res.status(403).send('Unauthorized: Only organization admins can unban participants');
        }

        // Update ban status to inactive
        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE event_bans
                SET status = 'inactive'
                WHERE event_id = ? AND user_id = ?
            `, [eventId, userId], (err) => {
                if (err) reject(err);
                resolve();
            });
        });

        res.redirect(`/events/${eventId}`);
    } catch (err) {
        console.error(err);
        res.status(500).send('Error unbanning participant');
    }
});

module.exports = router; 