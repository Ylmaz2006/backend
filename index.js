require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const Stripe = require('stripe');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

console.log('Private Key:', process.env.FIREBASE_PRIVATE_KEY.slice(0, 50), '...');

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
  }),
});

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const PORT = process.env.PORT || 5000;

const MONGO_URI = process.env.MONGO_URL;
mongoose.connect(MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => console.log('✅ MongoDB connected'))
.catch(err => console.error('❌ MongoDB connection error:', err));

// CORS
const allowedOrigins = [
  'http://localhost:3000',
  'https://yumu2-91939.web.app',
  'https://yumu2-91939.firebaseapp.com'
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS not allowed'), false);
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  optionsSuccessStatus: 204
}));

app.options('*', cors());
app.use(bodyParser.json());

// Nodemailer
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Mongoose User schema
const userSchema = new mongoose.Schema({
  username: String,
  email: { type: String, required: true, unique: true },
  password: String,
  stripeCustomerId: String,
  isVerified: { type: Boolean, default: false },
  verificationToken: String,
  lastPaymentIntentId: String,
  paymentStatus: { type: String, default: 'Free' }
});
const User = mongoose.model('User', userSchema);

// Routes

app.post('/signup', async (req, res) => {
  const { email, password, paymentIntentId } = req.body;
  try {
    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'Email already exists' });

    const customer = await stripe.customers.create({ email });
    const hashedPassword = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const defaultUsername = email.split('@')[0];

    const newUser = new User({
      username: defaultUsername,
      email,
      password: hashedPassword,
      stripeCustomerId: customer.id,
      verificationToken,
      isVerified: false,
      paymentStatus: paymentIntentId ? 'Premium' : 'Free',
      lastPaymentIntentId: paymentIntentId || undefined
    });

    await newUser.save();

    const verifyUrl = `https://yumu2-91939.web.app/verify-email?token=${verificationToken}&email=${email}`;
    await transporter.sendMail({
      from: `AI App <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Verify Your Email',
      html: `<p>Click to verify: <a href="${verifyUrl}">${verifyUrl}</a></p>`
    });

    res.status(200).json({ message: 'Signup successful, please verify your email' });
  } catch (err) {
    console.error("Signup Error:", err);
    res.status(500).json({ message: 'Signup error' });
  }
});

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
    const decodedToken = await admin.auth().verifyIdToken(token);
    const { email } = decodedToken;
    let isNewUser = false;

    let user = await User.findOne({ email });

    if (!user) {
      isNewUser = true;
      const customer = await stripe.customers.create({ email });
      const defaultUsername = email.split('@')[0];

      user = new User({
        email,
        username: defaultUsername,
        stripeCustomerId: customer.id,
        isVerified: true,
        paymentStatus: 'Free'
      });

      await user.save();
    }

    res.status(200).json({
      message: 'Google login successful',
      email: user.email,
      isNewUser
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
      automatic_payment_methods: { enabled: true }
    });
    res.send({ clientSecret: paymentIntent.client_secret });
  } catch (e) {
    console.error("Error creating payment intent:", e);
    return res.status(400).send({ error: { message: e.message } });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend running at http://0.0.0.0:${PORT}`);
});
