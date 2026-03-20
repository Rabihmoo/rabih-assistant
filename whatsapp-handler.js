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
let isProcessing = false;
let lastConnectedNotify = 0;
const sentMessages = new Set();
const processedMessages = new Set();

// Use /data (Railway Volume) if available, fallback to /tmp
const DATA_DIR = fs.existsSync('/data') ? '/data' : '/tmp';
const QR_SENT_FILE = path.join(DATA_DIR, 'wa_qr_sent');
const AUTH_FOLDER = path.join(DATA_DIR, 'baileys_auth');

console.log('WhatsApp auth folder:', AUTH_FOLDER);

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

function forceNewQR() {
  clearQRSent();
  console.log('QR flag cleared - next QR event will be sent to Telegram');
}

function getWhatsAppSocket() {
  return currentSock;
}

async function initWhatsApp(telegramToken, rabihChatId, onMessage) {
  const logger = pino({ level: 'silent' });
  const RABIH_JID = '258855254847@s.whatsapp.net';

  async function connect() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
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
          form.append('caption', 'Scan this QR with WhatsApp. Open WhatsApp > Linked Devices > Link a Device.\n\nSend /wa_qr if you need a fresh QR code.');
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
        console.log('WhatsApp connected! Auth saved to:', AUTH_FOLDER);
        // Only notify Telegram once per 6 hours to avoid spam on reconnections
        const now = Date.now();
        if (now - lastConnectedNotify > 6 * 60 * 60 * 1000) {
          lastConnectedNotify = now;
          await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
            chat_id: rabihChatId,
            text: 'WhatsApp connected and session saved. You will not need to scan again unless you log out.'
          }).catch(function() {});
        }
      }

      if (connection === 'close') {
        isConnected = false;
        const statusCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log('WhatsApp disconnected, code:', statusCode, 'reconnecting:', shouldReconnect);
        if (shouldReconnect) {
          setTimeout(connect, 5000);
        } else {
          try {
            fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
            console.log('Auth folder cleared after logout');
          } catch(e) {}
          clearQRSent();
          await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
            chat_id: rabihChatId,
            text: 'WhatsApp logged out. Send /wa_qr to get a new QR code.'
          }).catch(function() {});
        }
      }
    });

    sock.ev.on('messages.upsert', async function(m) {
      try {
        if (m.type !== 'notify') return;
        const msg = m.messages[0];
        if (!msg) return;
        if (!msg.message) return;

        const from = msg.key.remoteJid;
        const messageId = msg.key.id;

        if (!from.includes('258855254847') && !from.includes('@lid')) {
          console.log('Ignoring message from:', from);
          return;
        }

        const text = (
          (msg.message.conversation) ||
          (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
          ''
        );

        if (!text || !text.trim()) {
          console.log('Skipping non-text message from:', from);
          return;
        }

        if (processedMessages.has(messageId)) {
          console.log('Skipping duplicate:', messageId);
          return;
        }
        processedMessages.add(messageId);
        setTimeout(function() { processedMessages.delete(messageId); }, 60000);

        if (sentMessages.has(messageId)) {
          sentMessages.delete(messageId);
          return;
        }

        // Prevent processing while bot is already generating a reply (race condition fix)
        if (isProcessing) {
          console.log('Skipping message — already processing another:', text.substring(0, 50));
          return;
        }

        console.log('WhatsApp message from ' + from + ' (fromMe:' + msg.key.fromMe + '): ' + text);

        isProcessing = true;
        try {
          const response = await onMessage(text, 'whatsapp', RABIH_JID);
          console.log('WhatsApp reply ready:', response ? response.substring(0, 80) : 'null - suppressed');

          if (response && currentSock) {
            // Pre-register message to sentMessages to prevent race condition
            const sent = await currentSock.sendMessage(RABIH_JID, { text: response });
            if (sent && sent.key && sent.key.id) {
              sentMessages.add(sent.key.id);
              processedMessages.add(sent.key.id);
              setTimeout(function() { sentMessages.delete(sent.key.id); }, 60000);
              setTimeout(function() { processedMessages.delete(sent.key.id); }, 60000);
            }
            console.log('WhatsApp reply sent OK');
          }
        } finally {
          isProcessing = false;
        }
      } catch (err) {
        isProcessing = false;
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

module.exports = { initWhatsApp: initWhatsApp, getWhatsAppSocket: getWhatsAppSocket, forceNewQR: forceNewQR };
