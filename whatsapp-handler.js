const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const pino = require('pino');
const path = require('path');
const fs = require('fs');

let currentSock = null;
let qrSent = false;
let isConnected = false;
const sentMessages = new Set();
const processedMessages = new Set();

const QR_SENT_FILE = '/tmp/wa_qr_sent';

function markQRSent() {
  try { fs.writeFileSync(QR_SENT_FILE, '1'); } catch(e) {}
  qrSent = true;
}

function wasQRSent() {
  if (qrSent) return true;
  try { return fs.existsSync(QR_SENT_FILE); } catch(e) { return false; }
}

function clearQRSent() {
  try { fs.unlinkSync(QR_SENT_FILE); } catch(e) {}
  qrSent = false;
}

function getWhatsAppSocket() {
  return currentSock;
}

async function initWhatsApp(telegramToken, rabihChatId, onMessage) {
  const logger = pino({ level: 'silent' });
  const authFolder = path.join('/tmp', 'baileys_auth');
  const RABIH_JID = '258855254847@s.whatsapp.net';

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.0.0'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000
    });

    currentSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async function(update) {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        if (wasQRSent()) {
          console.log('QR already sent - skipping');
          return;
        }
        markQRSent();
        console.log('WhatsApp QR received, sending to Telegram...');
        try {
          const qrBuffer = await qrcode.toBuffer(qr, { type: 'png', width: 400 });
          const form = new FormData();
          form.append('chat_id', rabihChatId);
          form.append('caption', 'Scan this QR with WhatsApp. Open WhatsApp > Linked Devices > Link a Device.');
          form.append('photo', qrBuffer, { filename: 'qr.png', contentType: 'image/png' });
          await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendPhoto', form, {
            headers: form.getHeaders()
          });
          console.log('QR sent to Telegram OK');
        } catch (err) {
          console.error('Failed to send QR:', err.message);
          clearQRSent();
        }
      }

      if (connection === 'open') {
        isConnected = true;
        currentSock = sock;
        clearQRSent();
        console.log('WhatsApp connected!');
        await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
          chat_id: rabihChatId,
          text: 'WhatsApp connected! Send me a message on WhatsApp now.'
        }).catch(function() {});
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp disconnected, code:', statusCode, 'reconnecting:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(connect, 5000);
        } else {
          clearQRSent();
          await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
            chat_id: rabihChatId,
            text: 'WhatsApp logged out. Send /wa_connect to get a new QR code.'
          }).catch(function() {});
        }
      }
    });

    sock.ev.on('messages.upsert', async function(m) {
      try {
        // Only handle real-time incoming messages, not history sync
        if (m.type !== 'notify') return;

        const msg = m.messages[0];
        if (!msg) return;

        // Skip messages with no content (server ack events - null message)
        // IMPORTANT: must check this BEFORE touching processedMessages,
        // otherwise the real message with content arrives later and gets
        // wrongly skipped as a duplicate
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const messageId = msg.key.id;

        // Only process messages from Rabih's number or LID-based JIDs
        if (!from.includes('258855254847') && !from.includes('@lid')) {
          console.log('Ignoring message from:', from);
          return;
        }

        // Extract text BEFORE adding to processedMessages
        // This prevents the race condition where a null-content event
        // consumes the messageId and blocks the real message
        const text = (
          (msg.message.conversation) ||
          (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
          ''
        );

        if (!text || !text.trim()) {
          console.log('Skipping non-text message type from:', from);
          return;
        }

        // Now safe to mark as processed
        if (processedMessages.has(messageId)) {
          console.log('Skipping duplicate:', messageId);
          return;
        }
        processedMessages.add(messageId);
        setTimeout(function() { processedMessages.delete(messageId); }, 60000);

        // Skip bot's own sent messages (they also fire messages.upsert with fromMe:true)
        if (sentMessages.has(messageId)) {
          sentMessages.delete(messageId);
          return;
        }

        console.log('WhatsApp message from ' + from + ' (fromMe:' + msg.key.fromMe + '): ' + text);

        const response = await onMessage(text, 'whatsapp', RABIH_JID);
        console.log('WhatsApp reply ready:', response ? response.substring(0, 80) : 'empty');

        if (response && currentSock) {
          const sent = await currentSock.sendMessage(RABIH_JID, { text: response });
          if (sent && sent.key && sent.key.id) {
            sentMessages.add(sent.key.id);
            setTimeout(function() { sentMessages.delete(sent.key.id); }, 30000);
          }
          console.log('WhatsApp reply sent OK');
        }
      } catch (err) {
        console.error('WhatsApp message error:', err.message);
        try {
          if (currentSock) await currentSock.sendMessage('258855254847@s.whatsapp.net', { text: 'Error: ' + err.message });
        } catch(e) {}
      }
    });
  }

  try {
    await connect();
    console.log('WhatsApp initializing with Baileys...');
  } catch (err) {
    console.error('WhatsApp init error:', err.message);
    setTimeout(connect, 10000);
  }
}

module.exports = { initWhatsApp: initWhatsApp, getWhatsAppSocket: getWhatsAppSocket };
