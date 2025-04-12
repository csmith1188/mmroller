const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');

const app = express();
const port = 3000;

// Import route files
const authRoutes = require('./routes/auth');
const profileRoutes = require('./routes/profile');
const organizationRoutes = require('./routes/organizations');
const eventRoutes = require('./routes/events');
const matchRoutes = require('./routes/matches');

// Database setup
const dbPath = path.join(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath);

// Authentication middleware
const requireLogin = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect('/login');
    }
    next();
};

// Make db and requireLogin available to route files
app.locals.db = db;
app.locals.requireLogin = requireLogin;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Session middleware
app.use(session({
    store: new SQLiteStore({
        db: 'database.sqlite',
        dir: path.join(__dirname, 'database')
    }),
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, // Set to true if using HTTPS
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Add user to all views
app.use((req, res, next) => {
    if (req.session.userId) {
        db.get('SELECT id, username FROM users WHERE id = ?', [req.session.userId], (err, user) => {
            if (err) {
                console.error(err);
                return next(err);
            }
            res.locals.user = user;
            res.locals.userId = req.session.userId;
            next();
        });
    } else {
        res.locals.user = null;
        res.locals.userId = null;
        next();
    }
});

// Routes
app.get('/', (req, res) => {
    res.redirect('/login');
});

// Use route files
app.use('/', authRoutes);
app.use('/', profileRoutes);
app.use('/', organizationRoutes);
app.use('/', eventRoutes);
app.use('/', matchRoutes);

// Start server
app.listen(port, () => {
    console.log(`Server running at http://localhost:${port}`);
});

// Close database connection when the app is shutting down
process.on('SIGINT', () => {
    db.close();
    process.exit();
}); 