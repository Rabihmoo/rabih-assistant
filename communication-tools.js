const axios = require('axios');

let whatsAppSocket = null;

function setWhatsAppSocket(sock) {
  whatsAppSocket = sock;
}

// Send WhatsApp message to any number
async function sendWhatsAppMessage(phoneNumber, message) {
  if (!whatsAppSocket) {
    return { error: 'WhatsApp not connected' };
  }
  try {
    // Clean phone number - remove +, spaces, dashes
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    const jid = cleaned + '@s.whatsapp.net';
    await whatsAppSocket.sendMessage(jid, { text: message });
    return { success: true, sent_to: phoneNumber, message: message };
  } catch (err) {
    return { error: err.message };
  }
}

// Make a phone call via Twilio
async function makePhoneCall(phoneNumber, message, language) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    return { error: 'Twilio not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER to Railway env vars.' };
  }

  try {
    const cleaned = phoneNumber.replace(/[^0-9+]/g, '');
    const toNumber = cleaned.startsWith('+') ? cleaned : '+' + cleaned;

    // Choose voice based on language
    const voice = (language && language.toLowerCase().includes('ar')) ? 'Polly.Zeina' : 'Polly.Joanna';
    const lang = (language && language.toLowerCase().includes('ar')) ? 'ar-SA' : 'en-US';

    // Build TwiML
    const twiml = '<Response><Say voice="' + voice + '" language="' + lang + '">' + message + '</Say></Response>';
    const twimlEncoded = encodeURIComponent(twiml);
    const twimlUrl = 'http://twimlets.com/echo?Twiml=' + twimlEncoded;

    const response = await axios.post(
      'https://api.twilio.com/2010-04-01/Accounts/' + accountSid + '/Calls.json',
      new URLSearchParams({
        To: toNumber,
        From: fromNumber,
        Url: twimlUrl
      }).toString(),
      {
        auth: { username: accountSid, password: authToken },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      }
    );

    return {
      success: true,
      call_sid: response.data.sid,
      to: toNumber,
      status: response.data.status,
      message: message
    };
  } catch (err) {
    const errMsg = err.response && err.response.data ? JSON.stringify(err.response.data) : err.message;
    return { error: errMsg };
  }
}

const communicationTools = [
  {
    name: 'send_whatsapp_message',
    description: 'Send a WhatsApp message to any phone number. Use when Rabih says send WhatsApp to someone, message someone on WhatsApp, or notify someone via WhatsApp.',
    input_schema: {
      type: 'object',
      properties: {
        phone_number: { type: 'string', description: 'Phone number with country code e.g. +258841234567 or +96171234567' },
        message: { type: 'string', description: 'The message to send. Can be in Arabic or English.' }
      },
      required: ['phone_number', 'message']
    }
  },
  {
    name: 'make_phone_call',
    description: 'Make a real phone call to any number and speak a message. The bot calls the number and reads the message aloud in Arabic or English. Use when Rabih says call someone, phone someone, or ring someone.',
    input_schema: {
      type: 'object',
      properties: {
        phone_number: { type: 'string', description: 'Phone number with country code e.g. +258841234567' },
        message: { type: 'string', description: 'What to say during the call' },
        language: { type: 'string', description: 'Language: english or arabic. Default english.' }
      },
      required: ['phone_number', 'message']
    }
  }
];

async function handleCommunicationTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'send_whatsapp_message': return await sendWhatsAppMessage(toolInput.phone_number, toolInput.message);
      case 'make_phone_call': return await makePhoneCall(toolInput.phone_number, toolInput.message, toolInput.language || 'english');
      default: return { error: 'Unknown tool: ' + toolName };
    }
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { communicationTools, handleCommunicationTool, setWhatsAppSocket };
