const axios = require('axios');

let whatsAppSocket = null;

function setWhatsAppSocket(sock) {
  whatsAppSocket = sock;
}

async function sendWhatsAppMessage(phoneNumber, message) {
  if (!whatsAppSocket) return { error: 'WhatsApp not connected' };
  try {
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    const jid = cleaned + '@s.whatsapp.net';
    await whatsAppSocket.sendMessage(jid, { text: message });
    return { success: true, sent_to: phoneNumber, message: message };
  } catch (err) {
    return { error: err.message };
  }
}

async function makePhoneCall(phoneNumber, message, language) {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  const callerId = process.env.AT_CALLER_ID;

  if (!apiKey || !username || !callerId) {
    return { error: "Africa's Talking not configured. Add AT_API_KEY, AT_USERNAME, AT_CALLER_ID to Railway env vars. Sign up free at africastalking.com - works in Mozambique and Lebanon." };
  }

  try {
    const cleaned = phoneNumber.replace(/[^0-9+]/g, '');
    const toNumber = cleaned.startsWith('+') ? cleaned : '+' + cleaned;

    const response = await axios.post(
      'https://voice.africastalking.com/call',
      new URLSearchParams({
        username: username,
        to: toNumber,
        from: callerId,
        clientRequestId: 'rabih_' + Date.now()
      }).toString(),
      {
        headers: {
          'apiKey': apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json'
        }
      }
    );

    return {
      success: true,
      call_id: response.data.entries && response.data.entries[0] && response.data.entries[0].sessionId,
      to: toNumber,
      status: response.data.entries && response.data.entries[0] && response.data.entries[0].status,
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
    description: "Send a WhatsApp message to any phone number. Use when Rabih says send WhatsApp to someone, message someone on WhatsApp, or notify someone. Can send in Arabic or English.",
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
    description: "Make a real phone call via Africa's Talking. Works in Mozambique and Lebanon. Use when Rabih says call someone, phone someone, or ring someone.",
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

module.exports = { communicationTools: communicationTools, handleCommunicationTool: handleCommunicationTool, setWhatsAppSocket: setWhatsAppSocket };
