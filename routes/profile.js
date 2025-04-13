const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// Profile routes
router.get('/profile', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.session.userId;

    if (!userId) {
        return res.redirect('/login');
    }

    try {
        // Get user info
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT id, COALESCE(username, discordname) as display_name, email, password_hash IS NOT NULL as has_password FROM users WHERE id = ?', [userId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!user) {
            return res.status(404).send('User not found');
        }

        // Get user's organizations
        const organizations = await new Promise((resolve, reject) => {
            db.all(`
                SELECT o.*, 
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin,
                       CASE WHEN o.created_by = ? THEN 1 ELSE 0 END as is_creator
                FROM organizations o
                JOIN organization_members om ON o.id = om.organization_id
                WHERE om.user_id = ?
            `, [userId, userId, userId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Get user's events with stats
        const events = await new Promise((resolve, reject) => {
            db.all(`
                SELECT e.*, o.name as organization_name,
                       pes.mmr, pes.matches_played, pes.wins, pes.losses,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins oa
                           JOIN organizations o ON oa.organization_id = o.id
                           WHERE oa.user_id = ? AND o.id = e.organization_id
                       ) THEN 1 ELSE 0 END as is_admin
                FROM events e
                JOIN organizations o ON e.organization_id = o.id
                JOIN event_participants ep ON e.id = ep.event_id
                LEFT JOIN player_event_stats pes ON e.id = pes.event_id AND pes.user_id = ?
                WHERE ep.user_id = ?
                ORDER BY e.start_date DESC
            `, [userId, userId, userId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        res.render('profile', {
            user,
            organizations,
            events,
            isAdmin: req.session.isAdmin,
            isViewingOwnProfile: true
        });
    } catch (error) {
        console.error('Error fetching profile:', error);
        res.status(500).send('Error fetching profile');
    }
});

// Edit profile routes
router.get('/profile/edit', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.session.userId;
    
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.redirect('/login');
        }
        
        res.render('edit-profile', { user });
    });
});

router.post('/profile/edit', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.session.userId;
    const { username, email } = req.body;
    
    db.run(
        'UPDATE users SET username = ?, email = ? WHERE id = ?',
        [username, email, userId],
        (err) => {
            if (err) {
                return res.status(500).send('Error updating profile');
            }
            
            res.redirect('/profile');
        }
    );
});

// Change password routes
router.get('/profile/change-password', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    res.render('change-password');
});

router.post('/profile/change-password', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.session.userId;
    const { current_password, new_password, confirm_password } = req.body;
    
    if (new_password !== confirm_password) {
        return res.render('change-password', { error: 'New passwords do not match' });
    }
    
    db.get('SELECT password FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.redirect('/login');
        }
        
        bcrypt.compare(current_password, user.password, (err, result) => {
            if (err || !result) {
                return res.render('change-password', { error: 'Current password is incorrect' });
            }
            
            bcrypt.hash(new_password, 10, (err, hash) => {
                if (err) {
                    return res.status(500).send('Error hashing password');
                }
                
                db.run(
                    'UPDATE users SET password = ? WHERE id = ?',
                    [hash, userId],
                    (err) => {
                        if (err) {
                            return res.status(500).send('Error updating password');
                        }
                        
                        res.redirect('/profile');
                    }
                );
            });
        });
    });
});

// View another user's profile
router.get('/profile/:id', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const profileId = req.params.id;
    const userId = req.session.userId;
    const isViewingOwnProfile = userId === parseInt(profileId);

    try {
        // Get user details
        const user = await new Promise((resolve, reject) => {
            db.get('SELECT *, COALESCE(username, discordname) as display_name, discord_id IS NOT NULL as is_discord_user FROM users WHERE id = ?', [profileId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!user) {
            return res.status(404).send('User not found');
        }

        // Get user's organizations (excluding banned ones)
        const organizations = await new Promise((resolve, reject) => {
            db.all(`
                SELECT o.*,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin,
                       CASE WHEN o.created_by = ? THEN 1 ELSE 0 END as is_creator
                FROM organizations o
                JOIN organization_members om ON o.id = om.organization_id
                WHERE om.user_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM organization_bans 
                    WHERE organization_id = o.id AND user_id = ? AND status = 'active'
                )
                ORDER BY o.name
            `, [profileId, profileId, profileId, profileId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Get user's events (excluding banned ones)
        const events = await new Promise((resolve, reject) => {
            db.all(`
                SELECT e.*, o.name as organization_name,
                       pes.mmr, pes.matches_played, pes.wins, pes.losses,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin
                FROM events e
                JOIN organizations o ON e.organization_id = o.id
                JOIN event_participants ep ON e.id = ep.event_id
                LEFT JOIN player_event_stats pes ON e.id = pes.event_id AND pes.user_id = ?
                WHERE ep.user_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM event_bans 
                    WHERE event_id = e.id AND user_id = ? AND status = 'active'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM organization_bans 
                    WHERE organization_id = o.id AND user_id = ? AND status = 'active'
                )
                ORDER BY e.start_date DESC
            `, [profileId, profileId, profileId, profileId, profileId], (err, rows) => {
                if (err) reject(err);
                resolve(rows.map(event => ({
                    ...event,
                    mmr: event.mmr || 1500,
                    matches_played: event.matches_played || 0,
                    wins: event.wins || 0,
                    losses: event.losses || 0
                })));
            });
        });

        // Get user's match history
        const matches = await new Promise((resolve, reject) => {
            db.all(`
                SELECT m.*, e.name as event_name, o.name as organization_name,
                       GROUP_CONCAT(u.username) as player_names,
                       GROUP_CONCAT(u.id) as player_ids,
                       GROUP_CONCAT(mp.position) as positions,
                       GROUP_CONCAT(mp.final_score) as final_scores
                FROM matches m
                JOIN match_players mp ON m.id = mp.match_id
                JOIN users u ON mp.user_id = u.id
                JOIN events e ON m.event_id = e.id
                JOIN organizations o ON e.organization_id = o.id
                WHERE mp.user_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM event_bans 
                    WHERE event_id = e.id AND user_id = ? AND status = 'active'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM organization_bans 
                    WHERE organization_id = o.id AND user_id = ? AND status = 'active'
                )
                GROUP BY m.id
                ORDER BY m.created_at DESC
            `, [profileId, profileId, profileId], (err, rows) => {
                if (err) reject(err);
                resolve(rows.map(match => ({
                    ...match,
                    player_names: match.player_names ? match.player_names.split(',') : [],
                    player_ids: match.player_ids ? match.player_ids.split(',').map(Number) : [],
                    positions: match.positions ? match.positions.split(',').map(Number) : [],
                    final_scores: match.final_scores ? match.final_scores.split(',').map(Number) : []
                })));
            });
        });

        res.render('profile', {
            user,
            organizations,
            events,
            matches,
            isViewingOwnProfile,
            userId
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching profile');
    }
});

module.exports = router;