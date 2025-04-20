require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const passport = require('passport');
const DiscordStrategy = require('passport-discord').Strategy;

const app = express();
const port = process.env.PORT || 3000;

// Import route files
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const organizationRoutes = require('./routes/organizations');
const eventRoutes = require('./routes/events');
const matchRoutes = require('./routes/matches');

// Database setup
const dbPath = path.join(__dirname, 'database', 'database.db');
console.log('Database path:', dbPath);

const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database:', err);
        process.exit(1);
    }
    console.log('Database opened successfully');
});

// Authentication middleware
const requireLogin = (req, res, next) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    // Set session userId for compatibility with existing code
    req.session.userId = req.user.id;
    next();
};

// Verification middleware
const requireVerification = (req, res, next) => {
    // Allow access to profile and profile edit pages without verification
    if (req.path === '/profile' && !req.params.id || req.path === '/profile/edit') {
        return next();
    }
    
    // Check if user is verified
    if (!req.user.verified) {
        return res.status(403).render('error', { message: 'You must be verified to access this page. Please verify your account.' });
    }
    
    next();
};

// Make db and requireLogin available to route files
app.locals.db = db;
app.locals.requireLogin = requireLogin;
app.locals.requireVerification = requireVerification;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session middleware
app.use(session({
    store: new SQLiteStore({
        db: 'database.db',
        table: 'sessions',
        dir: path.join(__dirname, 'database')
    }),
    secret: process.env.SESSION_SECRET || 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Initialize passport
app.use(passport.initialize());
app.use(passport.session());

// Configure passport with Discord strategy if credentials are available
if (process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET) {
    passport.use(new DiscordStrategy({
        clientID: process.env.DISCORD_CLIENT_ID,
        clientSecret: process.env.DISCORD_CLIENT_SECRET,
        callbackURL: process.env.DISCORD_CALLBACK_URL || 'http://localhost:3000/discord/callback',
        scope: ['identify', 'email']
    }, async (accessToken, refreshToken, profile, done) => {
        try {
            const db = app.locals.db;
            console.log('Processing Discord profile:', profile);
            
            // First check by Discord ID
            const existingDiscordUser = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM users WHERE discord_id = ?', [profile.id], (err, row) => {
                    if (err) {
                        console.error('Error checking for Discord user:', err);
                        reject(err);
                    }
                    resolve(row);
                });
            });

            if (existingDiscordUser) {
                console.log('Found existing user by Discord ID:', existingDiscordUser);
                // Update user's info
                await new Promise((resolve, reject) => {
                    db.run(`
                        UPDATE users 
                        SET username = ?, email = ?, avatar = ?, updated_at = datetime('now')
                        WHERE discord_id = ?
                    `, [profile.username, profile.email, profile.avatar, profile.id], (err) => {
                        if (err) {
                            console.error('Error updating Discord user:', err);
                            reject(err);
                        }
                        resolve();
                    });
                });
                return done(null, existingDiscordUser);
            }

            // If no Discord user found, check by email
            const existingEmailUser = await new Promise((resolve, reject) => {
                db.get('SELECT * FROM users WHERE email = ?', [profile.email], (err, row) => {
                    if (err) {
                        console.error('Error checking for email user:', err);
                        reject(err);
                    }
                    resolve(row);
                });
            });

            if (existingEmailUser) {
                console.log('Found existing user by email:', existingEmailUser);
                // Update existing user with Discord info
                await new Promise((resolve, reject) => {
                    db.run(`
                        UPDATE users 
                        SET discord_id = ?, username = ?, avatar = ?, updated_at = datetime('now')
                        WHERE email = ?
                    `, [profile.id, profile.username, profile.avatar, profile.email], (err) => {
                        if (err) {
                            console.error('Error updating email user:', err);
                            reject(err);
                        }
                        resolve();
                    });
                });
                return done(null, existingEmailUser);
            }

            // If no user found at all, create new one
            console.log('Creating new user for Discord profile:', profile);
            const newUser = await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO users (username, email, discord_id, avatar, verified, created_at)
                    VALUES (?, ?, ?, ?, 1, datetime('now'))
                `, [profile.username, profile.email, profile.id, profile.avatar], function(err) {
                    if (err) {
                        console.error('Error creating new user:', err);
                        reject(err);
                    }
                    resolve({
                        id: this.lastID,
                        username: profile.username,
                        email: profile.email,
                        discord_id: profile.id,
                        avatar: profile.avatar
                    });
                });
            });
            console.log('Created new user:', newUser);
            return done(null, newUser);
        } catch (err) {
            console.error('Strategy error:', err);
            return done(err);
        }
    }));
} else {
    console.log('Discord OAuth credentials not found. Discord login is disabled.');
}

// Serialize and deserialize user
passport.serializeUser((user, done) => {
    done(null, user.id);
});

passport.deserializeUser((id, done) => {
    const db = app.locals.db;
    db.get('SELECT * FROM users WHERE id = ?', [id], (err, user) => {
        if (err) {
            console.error('Deserialize error:', err);
            return done(err);
        }
        done(null, user);
    });
});

// Add user to all views
app.use((req, res, next) => {
    if (req.isAuthenticated()) {
        res.locals.user = req.user;
        res.locals.userId = req.user.id;
    } else {
        res.locals.user = null;
        res.locals.userId = null;
    }
    next();
});

// Routes
// Use auth routes first - these should be accessible without login
app.use('/', authRoutes);

// Protected routes - require login and verification
app.get('/', requireLogin, requireVerification, (req, res) => {
    res.redirect('/profile');
});

app.use('/', requireLogin, requireVerification, profileRoutes);
app.use('/', requireLogin, requireVerification, organizationRoutes);
app.use('/', requireLogin, requireVerification, eventRoutes);
app.use('/', requireLogin, requireVerification, matchRoutes);

// Start server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// Close database connection when the app is shutting down
process.on('SIGINT', () => {
    db.close();
    process.exit();
}); 