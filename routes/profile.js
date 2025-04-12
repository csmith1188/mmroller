const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// Profile routes
router.get('/profile', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.session.userId;
    
    // Get user data
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err) {
            console.error(err);
            return res.status(500).send('Error fetching user data');
        }
        
        if (!user) {
            return res.redirect('/login');
        }
        
        // Get user's organizations
        db.all(`
            SELECT o.*, 
                   CASE WHEN o.admin_id = ? THEN 1 ELSE 0 END as is_admin,
                   CASE WHEN o.created_by = ? THEN 1 ELSE 0 END as is_creator
            FROM organizations o
            JOIN organization_members om ON o.id = om.organization_id
            WHERE om.user_id = ?
        `, [userId, userId, userId], (err, organizations) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error fetching organizations');
            }
            
            // Get user's events
            db.all(`
                SELECT e.*, o.name as organization_name
                FROM events e
                JOIN event_participants ep ON e.id = ep.event_id
                JOIN organizations o ON e.organization_id = o.id
                WHERE ep.user_id = ?
            `, [userId], (err, events) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Error fetching events');
                }
                
                res.render('profile', { 
                    user, 
                    organizations, 
                    events,
                    isViewingOwnProfile: true
                });
            });
        });
    });
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
router.get('/profile/:id', (req, res) => {
    const requireLogin = req.app.locals.requireLogin;
    const db = req.app.locals.db;
    const userId = req.params.id;
    const currentUserId = req.session.userId;
    
    // Get user data
    db.get('SELECT * FROM users WHERE id = ?', [userId], (err, user) => {
        if (err || !user) {
            return res.status(404).send('User not found');
        }
        
        // Get user's organizations
        db.all(`
            SELECT o.*, 
                   CASE WHEN o.admin_id = ? THEN 1 ELSE 0 END as is_admin,
                   CASE WHEN o.created_by = ? THEN 1 ELSE 0 END as is_creator
            FROM organizations o
            JOIN organization_members om ON o.id = om.organization_id
            WHERE om.user_id = ?
        `, [userId, userId, userId], (err, organizations) => {
            if (err) {
                console.error(err);
                return res.status(500).send('Error fetching organizations');
            }
            
            // Get user's events
            db.all(`
                SELECT e.*, o.name as organization_name
                FROM events e
                JOIN event_participants ep ON e.id = ep.event_id
                JOIN organizations o ON e.organization_id = o.id
                WHERE ep.user_id = ?
            `, [userId], (err, events) => {
                if (err) {
                    console.error(err);
                    return res.status(500).send('Error fetching events');
                }
                
                res.render('profile', { 
                    user, 
                    organizations, 
                    events,
                    isViewingOwnProfile: userId === currentUserId
                });
            });
        });
    });
});

module.exports = router; 