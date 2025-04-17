const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const passport = require('passport');

// Middleware to redirect logged-in users away from auth pages
const redirectIfLoggedIn = (req, res, next) => {
    if (req.session.userId) {
        return res.redirect('/profile');
    }
    next();
};

// Login routes
router.get('/login', redirectIfLoggedIn, (req, res) => {
    const discordEnabled = !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
    res.render('login', { error: null, discordEnabled });
});

router.post('/login', redirectIfLoggedIn, (req, res) => {
    const { email, password } = req.body;
    const db = req.app.locals.db;
    
    db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
        if (err) {
            console.error('Login error:', err);
            return res.render('login', { error: 'Error during login. Please try again.' });
        }
        
        if (!user) {
            return res.render('login', { error: 'Invalid email or password' });
        }
        
        bcrypt.compare(password, user.password_hash, (err, result) => {
            if (err) {
                console.error('Password comparison error:', err);
                return res.render('login', { error: 'Error during login. Please try again.' });
            }
            
            if (!result) {
                return res.render('login', { error: 'Invalid email or password' });
            }
            
            req.login(user, (err) => {
                if (err) {
                    console.error('Passport login error:', err);
                    return res.render('login', { error: 'Error during login. Please try again.' });
                }
                res.redirect('/profile');
            });
        });
    });
});

// Register routes
router.get('/register', redirectIfLoggedIn, (req, res) => {
    res.render('register');
});

router.post('/register', redirectIfLoggedIn, (req, res) => {
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
                
                const newUser = {
                    id: this.lastID,
                    username: username,
                    email: email
                };
                
                req.login(newUser, (err) => {
                    if (err) {
                        console.error('Passport login error:', err);
                        return res.render('register', { error: 'Error creating account. Please try again.' });
                    }
                    res.redirect('/profile');
                });
            }
        );
    });
});

// Logout route
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Discord OAuth routes
router.get('/discord', passport.authenticate('discord'));

router.get('/discord/callback', 
    passport.authenticate('discord', { failureRedirect: '/login' }),
    (req, res) => {
        // Set session userId for compatibility
        req.session.userId = req.user.id;
        res.redirect('/profile');
    }
);

module.exports = router; 