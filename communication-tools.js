// v3
const axios = require('axios');

let _socket = null;

function setSocket(sock) {
  _socket = sock;
}

async function sendWhatsAppMessage(phoneNumber, message) {
  if (!_socket) return { error: 'WhatsApp not connected. Please scan the QR code first.' };
  try {
    const cleaned = phoneNumber.replace(/[^0-9]/g, '');
    const jid = cleaned + '@s.whatsapp.net';

    // Verify the number is registered on WhatsApp before sending.
    // Without this, Baileys throws a raw 400 from WhatsApp servers for unknown numbers.
    let checkResults;
    try {
      checkResults = await _socket.onWhatsApp(jid);
    } catch (checkErr) {
      console.error('onWhatsApp check failed:', checkErr.message);
      // If the check itself fails (network issue), try sending anyway
      checkResults = null;
    }

    if (checkResults && checkResults.length > 0 && !checkResults[0].exists) {
      return { error: 'Number ' + phoneNumber + ' is not registered on WhatsApp.' };
    }

    await _socket.sendMessage(jid, { text: message });
    console.log('WhatsApp sent to', jid, ':', message);
    return { success: true, sent_to: phoneNumber, message: message };
  } catch (err) {
    console.error('WhatsApp send error:', err.message);
    return { error: 'Failed to send WhatsApp to ' + phoneNumber + ': ' + (err.message || 'Unknown error') };
  }
}

async function listWhatsAppGroups() {
  if (!_socket) return { error: 'WhatsApp not connected. Please scan the QR code first.' };
  try {
    var groups = await _socket.groupFetchAllParticipating();
    var list = Object.values(groups).map(function(g) {
      return { name: g.subject, jid: g.id, participants: (g.participants || []).length };
    });
    list.sort(function(a, b) { return a.name.localeCompare(b.name); });
    return { count: list.length, groups: list };
  } catch (err) {
    console.error('List groups error:', err.message);
    return { error: 'Failed to list groups: ' + err.message };
  }
}

async function sendWhatsAppGroup(groupJid, message) {
  if (!_socket) return { error: 'WhatsApp not connected. Please scan the QR code first.' };
  try {
    var jid = groupJid.endsWith('@g.us') ? groupJid : groupJid + '@g.us';
    await _socket.sendMessage(jid, { text: message });
    console.log('WhatsApp group message sent to', jid, ':', message.substring(0, 80));
    return { success: true, sent_to: jid, message: message };
  } catch (err) {
    console.error('WhatsApp group send error:', err.message);
    return { error: 'Failed to send to group: ' + err.message };
  }
}

async function makePhoneCall(phoneNumber, message, language) {
  const apiKey = process.env.AT_API_KEY;
  const username = process.env.AT_USERNAME;
  const callerId = process.env.AT_CALLER_ID;
  if (!apiKey || !username || !callerId) {
    return { error: "Africa's Talking not configured. Add AT_API_KEY, AT_USERNAME, AT_CALLER_ID to Railway env vars." };
  }
  try {
    const cleaned = phoneNumber.replace(/[^0-9+]/g, '');
    const toNumber = cleaned.startsWith('+') ? cleaned : '+' + cleaned;
    const response = await axios.post(
      'https://voice.africastalking.com/call',
      new URLSearchParams({ username: username, to: toNumber, from: callerId, clientRequestId: 'rabih_' + Date.now() }).toString(),
      { headers: { 'apiKey': apiKey, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' } }
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
    name: 'list_whatsapp_groups',
    description: 'List all WhatsApp groups the bot is part of. Returns group names and JIDs. Use when Rabih asks about his groups, which groups, or before sending a group message.',
    input_schema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'send_whatsapp_group',
    description: 'Send a message to a WhatsApp group by its JID. Use list_whatsapp_groups first to get the JID. Use when Rabih says send to the group, message the team group, notify the staff group.',
    input_schema: {
      type: 'object',
      properties: {
        group_jid: { type: 'string', description: 'Group JID ending in @g.us. Get it from list_whatsapp_groups.' },
        message: { type: 'string', description: 'The message to send to the group.' }
      },
      required: ['group_jid', 'message']
    }
  },
  {
    name: 'make_phone_call',
    description: "Make a real phone call via Africa's Talking. Works in Mozambique and Lebanon.",
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
      case 'list_whatsapp_groups': return await listWhatsAppGroups();
      case 'send_whatsapp_group': return await sendWhatsAppGroup(toolInput.group_jid, toolInput.message);
      case 'make_phone_call': return await makePhoneCall(toolInput.phone_number, toolInput.message, toolInput.language || 'english');
      default: return { error: 'Unknown tool: ' + toolName };
    }
  } catch (err) {
    return { error: err.message };
  }
}

module.exports = { communicationTools: communicationTools, handleCommunicationTool: handleCommunicationTool, setSocket: setSocket };
