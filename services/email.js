const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Create a transporter using environment variables
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    },
    tls: {
        rejectUnauthorized: false
    },
    debug: true
});

// Verify transporter configuration
transporter.verify(function(error, success) {
    if (error) {
        console.error('SMTP Configuration Error:', error);
    } else {
        console.log('SMTP Server is ready to send emails');
    }
});

// Generate a verification token
function generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Send verification email
async function sendVerificationEmail(email, token) {
    const verificationUrl = `${process.env.BASE_URL}/verify?token=${token}`;
    
    const mailOptions = {
        from: process.env.SMTP_FROM,
        to: email,
        subject: 'Verify your MMRoller account',
        html: `
            <h1>Welcome to MMRoller!</h1>
            <p>Please click the link below to verify your email address:</p>
            <a href="${verificationUrl}">${verificationUrl}</a>
            <p>If you did not create an account, you can safely ignore this email.</p>
        `
    };
    
    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Error sending verification email:', error);
        return false;
    }
}

// Send password reset email
async function sendPasswordResetEmail(email, token) {
    const resetUrl = `${process.env.BASE_URL}/reset-password?token=${token}`;
    
    const mailOptions = {
        from: process.env.SMTP_FROM,
        to: email,
        subject: 'Reset your MMRoller password',
        html: `
            <h1>Password Reset Request</h1>
            <p>You have requested to reset your password. Click the link below to set a new password:</p>
            <a href="${resetUrl}">${resetUrl}</a>
            <p>If you did not request this password reset, you can safely ignore this email.</p>
            <p>This link will expire in 1 hour.</p>
        `
    };
    
    try {
        await transporter.sendMail(mailOptions);
        return true;
    } catch (error) {
        console.error('Error sending password reset email:', error);
        return false;
    }
}

module.exports = {
    generateVerificationToken,
    sendVerificationEmail,
    sendPasswordResetEmail
}; 