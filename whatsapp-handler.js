const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const pino = require('pino');
const path = require('path');

let sock = null;
let isConnected = false;
let qrSent = false;
const sentMessages = new Set();

async function initWhatsApp(telegramToken, rabihChatId, onMessage) {
  const logger = pino({ level: 'silent' });
  const authFolder = path.join('/tmp', 'baileys_auth');

  async function connect() {
    qrSent = false;
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '22.0.0']
    });

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
        isConnected = true;
        console.log('WhatsApp connected!');
        await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
          chat_id: rabihChatId,
          text: 'WhatsApp connected! Message yourself on WhatsApp to test.'
        }).catch(function() {});
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp disconnected, reconnecting:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(connect, 5000);
        } else {
          console.log('WhatsApp logged out - need to re-scan QR');
          await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
            chat_id: rabihChatId,
            text: 'WhatsApp logged out. Restart the bot to get a new QR.'
          }).catch(function() {});
        }
      }
    });

    sock.ev.on('messages.upsert', async function(m) {
      const msg = m.messages[0];
      if (!msg) return;
      if (m.type !== 'notify') return;

      const from = msg.key.remoteJid;
      const messageId = msg.key.id;

      // Only respond to Rabih's own number
      if (!from.includes('258855254847')) {
        console.log('Ignoring message from:', from);
        return;
      }

      // Skip messages the bot itself sent (to avoid infinite loop)
      if (sentMessages.has(messageId)) {
        sentMessages.delete(messageId);
        return;
      }

      // Get message text
      const text = msg.message && (
        (msg.message.conversation) ||
        (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
        (msg.message.imageMessage && msg.message.imageMessage.caption) ||
        ''
      );

      if (!text || !text.trim()) return;

      console.log('WhatsApp message: ' + text);

      try {
        const response = await onMessage(text, 'whatsapp', from);
        if (response && sock) {
          const sent = await sock.sendMessage(from, { text: response });
          if (sent && sent.key && sent.key.id) {
            sentMessages.add(sent.key.id);
            // Clean up after 30 seconds
            setTimeout(function() { sentMessages.delete(sent.key.id); }, 30000);
          }
        }
      } catch (err) {
        console.error('WhatsApp handler error:', err.message);
        if (sock) {
          await sock.sendMessage(from, { text: 'Error: ' + err.message }).catch(function() {});
        }
      }
    });
  }

  try {
    await connect();
    console.log('WhatsApp initializing with Baileys...');
  } catch (err) {
    console.error('WhatsApp init error:', err.message);
  }
}

module.exports = { initWhatsApp: initWhatsApp };
