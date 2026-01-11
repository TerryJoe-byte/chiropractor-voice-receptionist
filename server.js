cat > server.js <<'EOF'
import express from 'express';
import bodyParser from 'body-parser';
import twilio from 'twilio';
import Anthropic from '@anthropic-ai/sdk';
import pg from 'pg';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;
const app = express();
const port = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
);

if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const conversations = new Map();

const SYSTEM_PROMPT = `You are a professional AI receptionist for Harmony Chiropractic Center.
Collect patient information: name, phone, email, date of birth, reason for visit, insurance.
Ask ONE question at a time. Keep responses under 40 words. Be warm and professional.`;

function getConversation(callSid) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, {
      messages: [],
      patientData: { name: null, phone: null, email: null }
    });
  }
  return conversations.get(callSid);
}

app.post('/voice/incoming', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/voice/process',
    speechTimeout: 'auto',
    speechModel: 'phone_call'
  });
  gather.say({ voice: 'Polly.Joanna' },
    'Hello! Thank you for calling Harmony Chiropractic Center. May I have your full name please?');
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/process', async (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult;
  const conv = getConversation(callSid);
  conv.messages.push({ role: 'user', content: userSpeech });
  
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: conv.messages
    });
    
    const aiResponse = message.content[0].text;
    conv.messages.push({ role: 'assistant', content: aiResponse });
    
    const twiml = new twilio.twiml.VoiceResponse();
    const gather = twiml.gather({
      input: 'speech',
      action: '/voice/process',
      speechTimeout: 'auto'
    });
    gather.say({ voice: 'Polly.Joanna' }, aiResponse);
    res.type('text/xml').send(twiml.toString());
  } catch (error) {
    console.error('Error:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('I apologize, could you please repeat that?');
    res.type('text/xml').send(twiml.toString());
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
  console.log(`📞 Webhook: ${process.env.BASE_URL || 'http://localhost:' + port}/voice/incoming`);
});
EOF