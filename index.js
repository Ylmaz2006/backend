const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const stripe = require('stripe');
const FormData = require('form-data');
const fetch = require('node-fetch');
require('dotenv').config();
const { getVideoDurationInSeconds } = require('get-video-duration');
const app = express();
const PORT = process.env.PORT || 3001;
const axios = require('axios');

 CLIPTUNE_API = 'https://cliptune.replit.app';

app.use(cors());
app.use(express.json());
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
app.use(express.urlencoded({ extended: true }));

app.post('/api/process-video', upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No video uploaded." });

    const videoBuffer = req.file.buffer;
    const contentType = req.file.mimetype || 'video/mp4';

    const ticketRes = await axios.post(`${CLIPTUNE_API}/upload-ticket`);
    const { put_url, gcs_uri } = ticketRes.data;

    await axios.put(put_url, videoBuffer, {
      headers: { 'Content-Type': contentType },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const youtubeUrlsRaw = req.body.youtubeUrls || '[]';
    let youtubeUrls = [];
    try {
      youtubeUrls = JSON.parse(youtubeUrlsRaw);
    } catch {}

    const payload = new URLSearchParams({
      instrumental: req.body.instrumental || 'true',
      song_title: req.body.song_title || 'test_clip',
      video_duration: req.body.video_duration || '30',
      video_url: gcs_uri,
      youtube_urls: JSON.stringify(youtubeUrls),
      extra_description: req.body.extra_description || '',
      lyrics: req.body.lyrics || ''
    });

    const response = await axios.post(`${CLIPTUNE_API}/generate`, payload, {
      timeout: 1800000
    });

    return res.status(200).json(response.data);
  } catch (err) {
    console.error("❌ ClipTune generation failed:", err.response?.data || err.message);
    return res.status(500).json({
      error: "Music generation failed",
      details: err.response?.data || err.message
    });
  }
});


// MongoDB Connection
mongoose.connect(process.env.MONGO_URL, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
}).then(() => {
  console.log('Connected to MongoDB');
}).catch(err => {
  console.error('MongoDB connection error:', err);
});

// Stripe Configuration
const stripeInstance = stripe(process.env.STRIPE_SECRET_KEY);

// Email Configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Helper function to get video duration

// Mongoose Schema
const userSchema = new mongoose.Schema({
  username: String,
  email: { type: String, required: true, unique: true },
  password: String,
  stripeCustomerId: String,
  isVerified: { type: Boolean, default: false },
  verificationToken: String,
  lastPaymentIntentId: String,
  paymentStatus: { type: String, default: 'Free' },
});
const User = mongoose.model('User', userSchema);

// Your existing routes (signup, login, etc.) remain the same...
app.post('/signup', async (req, res) => {
  const { email, password, paymentIntentId } = req.body;
  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'Email already exists' });

    const customer = await stripe.customers.create({ email });
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const newUser = new User({
      username: email.split('@')[0],
      email,
      password: hashedPassword,
      stripeCustomerId: customer.id,
      verificationToken,
      isVerified: false,
      paymentStatus: paymentIntentId ? 'Premium' : 'Free',
      lastPaymentIntentId: paymentIntentId || undefined,
    });

    await newUser.save();

    const verifyUrl = `https://yumu2-91939.web.app/verify-email?token=${verificationToken}&email=${email}`;
    await transporter.sendMail({
      from: `AI App <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Verify Your Email',
      html: `<p>Click to verify: <a href="${verifyUrl}">${verifyUrl}</a></p>`,
    });

    res.status(200).json({ message: 'Signup successful, please verify your email' });
  } catch (err) {
    console.error("Signup Error:", err);
    res.status(500).json({ message: 'Signup error' });
  }
});

// Add other existing routes here (login, verify-email, etc.)...

app.get('/verify-email', async (req, res) => {
  const { token, email } = req.query;
  try {
    const user = await User.findOne({ email, verificationToken: token });
    if (!user) return res.status(400).send('Invalid token or email.');
    user.isVerified = true;
    user.verificationToken = undefined;
    await user.save();
    res.send('Email verified successfully!');
  } catch {
    res.status(500).send('Verification error.');
  }
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !user.password) return res.status(401).json({ message: 'Invalid credentials' });
    if (!user.isVerified) return res.status(401).json({ message: 'Please verify your email' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    res.status(200).json({ message: 'Login successful', email });
  } catch {
    res.status(500).json({ message: 'Login error' });
  }
});

app.post('/google-login', async (req, res) => {
  const { token } = req.body;
  try {
    // Ensure Firebase Admin SDK is initialized for this to work
    // const decodedToken = await admin.auth().verifyIdToken(token);
    // const { email } = decodedToken;
    // For demonstration if Firebase Admin SDK is not set up:
    const email = 'google_user@example.com'; // Placeholder if admin.auth() is commented out

    let user = await User.findOne({ email });
    let isNewUser = false;

    if (!user) {
      isNewUser = true;
      const customer = await stripe.customers.create({ email });
      user = new User({
        email,
        username: email.split('@')[0],
        stripeCustomerId: customer.id,
        isVerified: true,
        paymentStatus: 'Free',
      });
      await user.save();
    }

    res.status(200).json({
      message: 'Google login successful',
      email: user.email,
      isNewUser,
    });
  } catch (err) {
    console.error("Google Login Error:", err);
    res.status(401).json({ message: 'Google login failed' });
  }
});

app.post('/get-user', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.status(200).json({ username: user.username, email: user.email });
  } catch {
    res.status(500).json({ message: 'Failed to fetch user' });
  }
});

app.post('/check-payment-status', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ accountType: user.paymentStatus });
  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({ message: 'Server error while checking account status.' });
  }
});

app.post('/create-payment-intent', async (req, res) => {
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 1000,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
    });
    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (e) {
    console.error("Error creating payment intent:", e);
    res.status(400).send({ error: { message: e.message } });
  }
});

app.post('/complete-checkout', async (req, res) => {
  const { email, paymentIntentId } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found.' });

    user.lastPaymentIntentId = paymentIntentId;
    user.paymentStatus = 'Premium';
    await user.save();

    res.status(200).json({ message: 'Checkout completed successfully. Account is now Premium.' });
  } catch (error) {
    console.error('Error completing checkout:', error);
    res.status(500).json({ message: 'Server error while updating account.' });
  }
});
app.post('/check-credit-card', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user || !user.stripeCustomerId) {
      return res.status(404).json({ message: 'User or Stripe customer not found' });
    }

    const customer = await stripe.customers.retrieve(user.stripeCustomerId);
    const hasCreditCard = !!(customer.invoice_settings.default_payment_method);

    res.status(200).json({ hasCreditCard });
  } catch (err) {
    console.error("Error checking credit card:", err);
    res.status(500).json({ message: 'Failed to check credit card status' });
  }
});
app.post('/upgrade-to-premium', async (req, res) => {
  const { email } = req.body;
  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.paymentStatus = 'Premium';
    await user.save();

    res.status(200).json({ message: 'User upgraded to Premium' });
  } catch (err) {
    console.error("Upgrade error:", err);
    res.status(500).json({ message: 'Failed to upgrade user' });
  }
});
app.post('/cancel-premium', async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // OPTIONAL: You can cancel Stripe subscription here if you create subscriptions
    // For now, just downgrade in your database
    user.paymentStatus = 'Free';
    user.lastPaymentIntentId = undefined;
    await user.save();

    res.status(200).json({ message: 'Subscription cancelled, user downgraded to Free.' });
  } catch (error) {
    console.error('Error cancelling subscription:', error);
    res.status(500).json({ message: 'Failed to cancel subscription.' });
  }
});

// Start Server
app.listen(PORT, 'localhost', () => {
  console.log(`🚀 Backend running at http://localhost:${PORT}`);
});