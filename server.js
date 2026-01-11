const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { Pool } = require('pg');
const { google } = require('googleapis');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT || 5432,
});

// Google Calendar Setup
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/oauth2callback'
);

// Set credentials if refresh token exists
if (process.env.GOOGLE_REFRESH_TOKEN) {
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN
  });
}

const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const conversations = new Map();

const SYSTEM_PROMPT = `You are a professional, warm AI receptionist for Harmony Chiropractic Center.

Collect information in order:
1. Patient full name
2. Phone number
3. Email address
4. Date of birth
5. Reason for visit
6. Insurance provider
7. Insurance member ID

Guidelines:
- Be warm and professional
- Ask ONE question at a time
- Keep responses under 40 words
- Speak naturally as if on a phone call
- Offer appointment times when all info collected

Current patient data: {PATIENT_DATA}
Current stage: {STAGE}`;

function getConversation(callSid) {
  if (!conversations.has(callSid)) {
    conversations.set(callSid, {
      messages: [],
      patientData: {
        name: null, phone: null, email: null,
        dateOfBirth: null, reason: null,
        insurance: { provider: null, memberId: null }
      },
      stage: 'greeting'
    });
  }
  return conversations.get(callSid);
}

function extractPatientInfo(text, currentData) {
  const updates = { ...currentData };
  const lower = text.toLowerCase();

  const phoneMatch = text.match(/\b(\d{3}[-.\s]?\d{3}[-.\s]?\d{4})\b/);
  if (phoneMatch && !updates.phone) {
    updates.phone = phoneMatch[1].replace(/\D/g, '');
  }

  const emailMatch = text.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (emailMatch && !updates.email) {
    updates.email = emailMatch[0];
  }

  const dobMatch = text.match(/\b(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/);
  if (dobMatch && lower.includes('birth')) {
    updates.dateOfBirth = dobMatch[1];
  }

  const insurances = {
    'blue cross': 'Blue Cross Blue Shield',
    'aetna': 'Aetna', 'cigna': 'Cigna',
    'united': 'United Healthcare', 'humana': 'Humana'
  };

  for (const [key, value] of Object.entries(insurances)) {
    if (lower.includes(key) && !updates.insurance.provider) {
      updates.insurance.provider = value;
    }
  }

  const memberMatch = text.match(/\b([A-Z0-9]{6,15})\b/i);
  if (memberMatch && (lower.includes('member') || lower.includes('id'))) {
    updates.insurance.memberId = memberMatch[1].toUpperCase();
  }

  return updates;
}

// Create Google Calendar Event
async function createCalendarEvent(patientData, appointmentDate, appointmentTime) {
  try {
    const startDateTime = new Date(`${appointmentDate}T${appointmentTime}`);
    const endDateTime = new Date(startDateTime.getTime() + 30 * 60000); // 30 min appointment

    const event = {
      summary: `Patient: ${patientData.name}`,
      description: `Reason: ${patientData.reason || 'Chiropractic consultation'}\n\nPatient Info:\nPhone: ${patientData.phone}\nEmail: ${patientData.email}\nInsurance: ${patientData.insurance?.provider || 'Not provided'}`,
      start: {
        dateTime: startDateTime.toISOString(),
        timeZone: 'America/New_York', // Change to your timezone
      },
      end: {
        dateTime: endDateTime.toISOString(),
        timeZone: 'America/New_York',
      },
      attendees: [
        { email: patientData.email }
      ],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 24 * 60 }, // 1 day before
          { method: 'popup', minutes: 60 }, // 1 hour before
        ],
      },
    };

    const response = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID || 'primary',
      resource: event,
      sendUpdates: 'all', // Send email invites to attendees
    });

    console.log('Calendar event created:', response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error('Error creating calendar event:', error);
    // Don't fail the whole appointment if calendar fails
    return null;
  }
}

function determineStage(data) {
  if (!data.name) return 'name';
  if (!data.phone) return 'phone';
  if (!data.email) return 'email';
  if (!data.dateOfBirth) return 'dob';
  if (!data.reason) return 'reason';
  if (!data.insurance.provider) return 'insurance_provider';
  if (!data.insurance.memberId) return 'insurance_id';
  return 'scheduling';
}

async function savePatient(data, callSid) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    const result = await client.query(
      `INSERT INTO patients (name, phone, email, date_of_birth, call_sid) 
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [data.name, data.phone, data.email, data.dateOfBirth, callSid]
    );
    
    const patientId = result.rows[0].id;
    
    if (data.insurance.provider) {
      await client.query(
        `INSERT INTO insurance (patient_id, provider, member_id) 
         VALUES ($1, $2, $3)`,
        [patientId, data.insurance.provider, data.insurance.memberId]
      );
    }
    
    await client.query('COMMIT');
    return patientId;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
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
    'Hello! Thank you for calling Harmony Chiropractic Center. I am your AI assistant. May I have your full name, please?');
  
  res.type('text/xml').send(twiml.toString());
});

app.post('/voice/process', async (req, res) => {
  const callSid = req.body.CallSid;
  const userSpeech = req.body.SpeechResult;
  const from = req.body.From;
  
  const conv = getConversation(callSid);
  conv.patientData = extractPatientInfo(userSpeech, conv.patientData);
  
  if (!conv.patientData.phone && from) {
    conv.patientData.phone = from.replace(/\D/g, '');
  }
  
  conv.stage = determineStage(conv.patientData);
  conv.messages.push({ role: 'user', content: userSpeech });
  
  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      system: SYSTEM_PROMPT
        .replace('{PATIENT_DATA}', JSON.stringify(conv.patientData, null, 2))
        .replace('{STAGE}', conv.stage),
      messages: conv.messages
    });
    
    const aiResponse = message.content[0].text;
    conv.messages.push({ role: 'assistant', content: aiResponse });
    
    if (conv.stage === 'scheduling' && !conv.saved) {
      const patientId = await savePatient(conv.patientData, callSid);
      conv.patientId = patientId;
      conv.saved = true;
    }
    
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
    twiml.say('I apologize, could you please repeat?');
    res.type('text/xml').send(twiml.toString());
  }
});

app.post('/api/appointments/confirm', async (req, res) => {
  const { patientId, date, time, reason } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO appointments (patient_id, appointment_date, appointment_time, reason) 
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [patientId, date, time, reason]
    );
    
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const patientResult = await pool.query(
      'SELECT phone, name, email FROM patients WHERE id = $1', [patientId]
    );
    
    const patient = patientResult.rows[0];
    
    // Create Google Calendar event
    const calendarEvent = await createCalendarEvent(
      { 
        name: patient.name, 
        phone: patient.phone, 
        email: patient.email,
        reason: reason 
      },
      date,
      time
    );
    
    // Save calendar event ID to database
    if (calendarEvent) {
      await pool.query(
        'UPDATE appointments SET notes = $1 WHERE id = $2',
        [`Calendar Event: ${calendarEvent.htmlLink}`, result.rows[0].id]
      );
    }
    
    // Send SMS confirmation
    await client.messages.create({
      body: `Hi ${patient.name}, your appointment at Harmony Chiropractic is confirmed for ${date} at ${time}. You'll receive a calendar invite at ${patient.email}.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: `+1${patient.phone}`
    });
    
    res.json({ 
      success: true, 
      appointmentId: result.rows[0].id,
      calendarEventLink: calendarEvent?.htmlLink 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/patients/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, i.provider, i.member_id 
       FROM patients p 
       LEFT JOIN insurance i ON p.id = i.patient_id 
       WHERE p.id = $1`,
      [req.params.id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Patient not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

app.listen(port, () => {
  console.log(`Voice AI Receptionist running on port ${port}`);
  console.log(`Webhook URL: ${process.env.BASE_URL}/voice/incoming`);
});

process.on('SIGTERM', () => {
  pool.end();
  process.exit(0);
});