const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const pino = require('pino');
const path = require('path');

let sock = null;
let isConnected = false;

async function initWhatsApp(telegramToken, rabihChatId, onMessage) {
  const logger = pino({ level: 'silent' });
  const authFolder = path.join('/tmp', 'baileys_auth');

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      logger,
      auth: state,
      printQRInTerminal: false,
      browser: ['Rabih Assistant', 'Chrome', '1.0']
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async function(update) {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log('WhatsApp QR received, sending to Telegram...');
        try {
          const qrBuffer = await qrcode.toBuffer(qr, { type: 'png', width: 400 });
          const form = new FormData();
          form.append('chat_id', rabihChatId);
          form.append('caption', 'Scan this QR with WhatsApp to connect your bot. Open WhatsApp > Linked Devices > Link a Device.');
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
          text: 'WhatsApp connected! You can now send me messages on WhatsApp.'
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
      if (!msg || msg.key.fromMe) return;
      if (m.type !== 'notify') return;

      const from = msg.key.remoteJid;
      const text = msg.message && (
        (msg.message.conversation) ||
        (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
        ''
      );

      if (!text) return;

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
