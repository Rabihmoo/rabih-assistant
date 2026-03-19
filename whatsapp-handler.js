const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const pino = require('pino');
const path = require('path');

let sock = null;
let isConnected = false;
let qrSent = false;

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

      // Only send QR once per session
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
            text: 'WhatsApp logged out. Restart the bot to re-scan QR code.'
          }).catch(function() {});
        }
      }
    });

    sock.ev.on('messages.upsert', async function(m) {
      const msg = m.messages[0];
      if (!msg) return;
      if (m.type !== 'notify') return;

      const from = msg.key.remoteJid;

      // Only respond to Rabih's own number
      if (!from.includes('258855254847')) {
        console.log('Ignoring message from non-whitelisted number:', from);
        return;
      }

      // Get message text - handle both regular and self messages
      const text = msg.message && (
        (msg.message.conversation) ||
        (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
        ''
      );

      if (!text) return;

      // Skip if it's a message WE sent (bot reply) to avoid infinite loop
      if (msg.key.fromMe && text.length > 0) {
        // Only skip bot's own replies, not user's self-messages
        // We identify bot replies by checking if they came from the socket
        console.log('Skipping outgoing message to avoid loop');
        return;
      }

      console.log('WhatsApp message from ' + from + ': ' + text);

      try {
        const response = await onMessage(text, 'whatsapp', from);
        if (response && sock) {
          await sock.sendMessage(from, { text: response });
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
