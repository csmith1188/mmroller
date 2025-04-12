const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

// Login routes
router.get('/login', (req, res) => {
    res.render('login', { error: null });
});

router.post('/login', (req, res) => {
    const { username, password } = req.body;
    const db = req.app.locals.db;
    
    db.get('SELECT * FROM users WHERE username = ?', [username], (err, user) => {
        if (err) {
            console.error('Login error:', err);
            return res.render('login', { error: 'Error during login. Please try again.' });
        }
        
        if (!user) {
            return res.render('login', { error: 'Invalid username or password' });
        }
        
        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (err) {
                console.error('Password comparison error:', err);
                return res.render('login', { error: 'Error during login. Please try again.' });
            }
            
            if (!result) {
                return res.render('login', { error: 'Invalid username or password' });
            }
            
            req.session.userId = user.id;
            res.redirect('/profile');
        });
    });
});

// Register routes
router.get('/register', (req, res) => {
    res.render('register');
});

router.post('/register', (req, res) => {
    const { username, password, email } = req.body;
    const db = req.app.locals.db;
    
    // Validate input
    if (!username || !password || !email) {
        return res.render('register', { error: 'All fields are required' });
    }
    
    bcrypt.hash(password, 10, (err, hash) => {
        if (err) {
            console.error('Password hashing error:', err);
            return res.render('register', { error: 'Error creating account. Please try again.' });
        }
        
        db.run(
            'INSERT INTO users (username, password_hash, email) VALUES (?, ?, ?)',
            [username, hash, email],
            function(err) {
                if (err) {
                    console.error('Registration error:', err);
                    if (err.code === 'SQLITE_CONSTRAINT') {
                        if (err.message.includes('users.username')) {
                            return res.render('register', { error: 'Username already exists' });
                        } else if (err.message.includes('users.email')) {
                            return res.render('register', { error: 'Email already exists' });
                        }
                    }
                    return res.render('register', { error: 'Error creating account. Please try again.' });
                }
                
                req.session.userId = this.lastID;
                res.redirect('/profile');
            }
        );
    });
});

// Logout route
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

module.exports = router; 