const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

function formatDescription(description) {
    if (!description) return '';
    
    // Remove all \r characters
    let formatted = description.replace(/\r/g, '');
    
    // Replace \n with <br>
    formatted = formatted.replace(/\n/g, '<br>');
    
    // Replace multiple consecutive <br> with a maximum of two
    formatted = formatted.replace(/(<br>){3,}/g, '<br><br>');
    
    // Truncate to 128 characters and add ellipsis if needed
    if (formatted.length > 128) {
        formatted = formatted.substring(0, 128).trim() + '...';
    }
    
    return formatted;
}

function formatDescriptionNoTruncate(description) {
    if (!description) return '';
    
    // Remove all \r characters
    let formatted = description.replace(/\r/g, '');
    
    // Replace \n with <br>
    formatted = formatted.replace(/\n/g, '<br>');
    
    // Replace multiple consecutive <br> with a maximum of two
    formatted = formatted.replace(/(<br>){3,}/g, '<br><br>');
    
    return formatted;
}

// Profile routes
router.get('/profile', async (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.session.userId;

    if (!userId) {
        return res.redirect('/login');
    }

    try {
        // Get user details
        const user = await new Promise((resolve, reject) => {
            db.get(`
                SELECT id, username, email, created_at, verified,
                       username as display_name,
                       CASE WHEN discord_id IS NOT NULL THEN 1 ELSE 0 END as is_discord_user,
                       CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END as has_password,
                       (SELECT COUNT(*) FROM match_players WHERE user_id = users.id) as matches_played
                FROM users
                WHERE id = ?
            `, [userId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        // Get user's organizations
        const organizations = await new Promise((resolve, reject) => {
            db.all(`
                SELECT o.*,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin
                FROM organizations o
                JOIN organization_members om ON o.id = om.organization_id
                WHERE om.user_id = ?
                ORDER BY o.created_at DESC
            `, [userId, userId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Format organization descriptions
        organizations.forEach(org => {
            org.description = formatDescription(org.description);
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

        // Format event descriptions
        events.forEach(event => {
            event.description = formatDescription(event.description);
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
        return res.status(500).render('error', { message: 'Error fetching profile' });
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
    
    // First get the current user data to check if email is being changed
    db.get('SELECT email FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.status(500).render('error', { message: 'Error updating profile' });
        }
        
        // If email is being changed, unset verification status
        const emailChanged = user.email !== email;
        const verified = emailChanged ? 0 : undefined; // Only include verified in update if email changed
        
        const updateFields = ['username = ?', 'email = ?'];
        const updateValues = [username, email];
        
        if (emailChanged) {
            updateFields.push('verified = ?');
            updateValues.push(0);
        }
        
        updateValues.push(userId);
        
        db.run(
            `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
            updateValues,
            (err) => {
                if (err) {
                    return res.status(500).render('error', { message: 'Error updating profile' });
                }
                
                res.redirect('/profile');
            }
        );
    });
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
    const { currentPassword, newPassword, confirmPassword } = req.body;
    
    if (newPassword !== confirmPassword) {
        return res.render('change-password', { error: 'New passwords do not match' });
    }
    
    db.get('SELECT password_hash FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.redirect('/login');
        }
        
        bcrypt.compare(currentPassword, user.password_hash, (err, result) => {
            if (err || !result) {
                return res.render('change-password', { error: 'Current password is incorrect' });
            }
            
            bcrypt.hash(newPassword, 10, (err, hash) => {
                if (err) {
                    return res.status(500).render('error', { message: 'Error hashing password' });
                }
                
                db.run(
                    'UPDATE users SET password_hash = ? WHERE id = ?',
                    [hash, userId],
                    (err) => {
                        if (err) {
                            return res.status(500).render('error', { message: 'Error updating password' });
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
            db.get(`
                SELECT id, username, email, created_at, verified,
                       username as display_name,
                       CASE WHEN discord_id IS NOT NULL THEN 1 ELSE 0 END as is_discord_user,
                       CASE WHEN password_hash IS NOT NULL THEN 1 ELSE 0 END as has_password,
                       (SELECT COUNT(*) FROM match_players WHERE user_id = users.id) as matches_played
                FROM users
                WHERE id = ?
            `, [profileId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });

        if (!user) {
            return res.status(404).render('error', { message: 'User not found' });
        }

        // Get user's organizations
        const organizations = await new Promise((resolve, reject) => {
            db.all(`
                SELECT o.*,
                       CASE WHEN EXISTS (
                           SELECT 1 FROM organization_admins 
                           WHERE organization_id = o.id AND user_id = ?
                       ) THEN 1 ELSE 0 END as is_admin
                FROM organizations o
                JOIN organization_members om ON o.id = om.organization_id
                WHERE om.user_id = ?
                AND NOT EXISTS (
                    SELECT 1 FROM organization_bans 
                    WHERE organization_id = o.id AND user_id = ? AND status = 'active'
                )
                ORDER BY o.created_at DESC
            `, [userId, profileId, userId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        // Format organization descriptions
        organizations.forEach(org => {
            org.description = formatDescription(org.description);
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
            `, [userId, profileId, profileId, profileId, profileId], (err, rows) => {
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

        // Format event descriptions
        events.forEach(event => {
            event.description = formatDescription(event.description);
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
        return res.status(500).render('error', { message: 'Error fetching profile' });
    }
});

module.exports = router;