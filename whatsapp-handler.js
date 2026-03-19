const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const pino = require('pino');
const path = require('path');

let currentSock = null;
let qrSent = false;
const sentMessages = new Set();
const processedMessages = new Set();

async function initWhatsApp(telegramToken, rabihChatId, onMessage) {
  const logger = pino({ level: 'silent' });
  const authFolder = path.join('/tmp', 'baileys_auth');
  const RABIH_JID = '258855254847@s.whatsapp.net';

  async function connect() {
    qrSent = false;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.0.0'],
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 500
    });

    currentSock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async function(update) {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !qrSent) {
        qrSent = true;
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
          console.error('Failed to send QR to Telegram:', err.message);
        }
      }

      if (connection === 'open') {
        console.log('WhatsApp connected!');
        currentSock = sock;
        await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
          chat_id: rabihChatId,
          text: 'WhatsApp connected! Send me a message on WhatsApp now.'
        }).catch(function() {});
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp disconnected, code:', statusCode, 'reconnecting:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(connect, 5000);
        } else {
          await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
            chat_id: rabihChatId,
            text: 'WhatsApp logged out. Restart the bot to get a new QR.'
          }).catch(function() {});
        }
      }
    });

    sock.ev.on('messages.upsert', async function(m) {
      try {
        const msg = m.messages[0];
        if (!msg) return;

        const from = msg.key.remoteJid;
        const messageId = msg.key.id;

        // Only respond to Rabih's number or @lid (self-chat)
        if (!from.includes('258855254847') && !from.includes('@lid')) {
          console.log('Ignoring message from:', from);
          return;
        }

        // Dedup - skip if already processed this message ID
        if (processedMessages.has(messageId)) {
          console.log('Skipping duplicate message:', messageId);
          return;
        }
        processedMessages.add(messageId);
        setTimeout(function() { processedMessages.delete(messageId); }, 60000);

        // Skip messages the bot itself sent
        if (sentMessages.has(messageId)) {
          sentMessages.delete(messageId);
          return;
        }

        // Get message text
        const text = (
          (msg.message && msg.message.conversation) ||
          (msg.message && msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
          ''
        );

        if (!text || !text.trim()) return;

        console.log('WhatsApp message from ' + from + ': ' + text);

        const response = await onMessage(text, 'whatsapp', RABIH_JID);
        console.log('WhatsApp reply ready:', response ? response.substring(0, 80) : 'empty');

        if (response && currentSock) {
          const sent = await currentSock.sendMessage(RABIH_JID, { text: response });
          if (sent && sent.key && sent.key.id) {
            sentMessages.add(sent.key.id);
            setTimeout(function() { sentMessages.delete(sent.key.id); }, 30000);
          }
          console.log('WhatsApp reply sent to', RABIH_JID);
        }
      } catch (err) {
        console.error('WhatsApp message error:', err.message);
        try {
          if (currentSock) {
            await currentSock.sendMessage('258855254847@s.whatsapp.net', { text: 'Error: ' + err.message });
          }
        } catch (e2) { console.error('Error reply failed:', e2.message); }
      }
    });
  }

  try {
    await connect();
    console.log('WhatsApp initializing with Baileys...');
  } catch (err) {
    console.error('WhatsApp init error:', err.message);
    setTimeout(function() { connect(); }, 10000);
  }
}

function getWhatsAppSocket() {
  return currentSock;
}

module.exports = { initWhatsApp: initWhatsApp, getWhatsAppSocket: getWhatsAppSocket };
