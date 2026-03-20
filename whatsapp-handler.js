const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
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

// Options: { telegramToken, rabihChatId, onRabihMessage, onOtherMessage, onVoiceMessage }
async function initWhatsApp(options) {
  const logger = pino({ level: 'silent' });
  const telegramToken = options.telegramToken;
  const rabihChatId = options.rabihChatId;
  const onRabihMessage = options.onRabihMessage;
  const onOtherMessage = options.onOtherMessage;
  const onVoiceMessage = options.onVoiceMessage;
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
            text: 'WhatsApp connected and session saved.'
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

        // Skip group messages
        if (from.endsWith('@g.us') || from.endsWith('@broadcast')) {
          return;
        }

        // Dedup checks
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);
        setTimeout(function() { processedMessages.delete(messageId); }, 60000);

        if (sentMessages.has(messageId)) {
          sentMessages.delete(messageId);
          return;
        }

        // Prevent concurrent processing
        if (isProcessing) {
          console.log('Skipping message — already processing:', (from || '').substring(0, 20));
          return;
        }

        // Check if it's a voice/audio message
        var audioMsg = msg.message.audioMessage;
        if (audioMsg && onVoiceMessage) {
          console.log('WhatsApp voice message from ' + from);
          isProcessing = true;
          try {
            var audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: logger, reuploadRequest: sock.updateMediaMessage });
            var isFromRabih = from.includes('258855254847') || from.includes('@lid');
            var replyTo = isFromRabih ? RABIH_JID : from;
            var response = await onVoiceMessage(audioBuffer, audioMsg.mimetype || 'audio/ogg', from, isFromRabih);
            if (response && currentSock) {
              var sent = await currentSock.sendMessage(replyTo, { text: response });
              if (sent && sent.key && sent.key.id) {
                sentMessages.add(sent.key.id);
                processedMessages.add(sent.key.id);
                setTimeout(function() { sentMessages.delete(sent.key.id); }, 60000);
                setTimeout(function() { processedMessages.delete(sent.key.id); }, 60000);
              }
            }
          } finally {
            isProcessing = false;
          }
          return;
        }

        // Extract text
        var text = (
          (msg.message.conversation) ||
          (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
          ''
        );

        if (!text || !text.trim()) {
          console.log('Skipping non-text message from:', from);
          return;
        }

        var isFromRabih = from.includes('258855254847') || from.includes('@lid');
        console.log('WhatsApp message from ' + from + ' (rabih:' + isFromRabih + '): ' + text.substring(0, 80));

        isProcessing = true;
        try {
          if (isFromRabih) {
            // Rabih's own message — full assistant mode
            var response = await onRabihMessage(text, 'whatsapp', RABIH_JID);
            if (response && currentSock) {
              var sent = await currentSock.sendMessage(RABIH_JID, { text: response });
              if (sent && sent.key && sent.key.id) {
                sentMessages.add(sent.key.id);
                processedMessages.add(sent.key.id);
                setTimeout(function() { sentMessages.delete(sent.key.id); }, 60000);
                setTimeout(function() { processedMessages.delete(sent.key.id); }, 60000);
              }
              console.log('WhatsApp reply sent to Rabih OK');
            }
          } else if (onOtherMessage) {
            // Message from someone else — log and notify
            var senderNumber = from.replace('@s.whatsapp.net', '').replace('@lid', '');
            var reply = await onOtherMessage(text, senderNumber, from);
            if (reply && currentSock) {
              var sent = await currentSock.sendMessage(from, { text: reply });
              if (sent && sent.key && sent.key.id) {
                sentMessages.add(sent.key.id);
                processedMessages.add(sent.key.id);
                setTimeout(function() { sentMessages.delete(sent.key.id); }, 60000);
                setTimeout(function() { processedMessages.delete(sent.key.id); }, 60000);
              }
              console.log('WhatsApp reply sent to ' + senderNumber + ' OK');
            }
          }
        } finally {
          isProcessing = false;
        }
      } catch (err) {
        isProcessing = false;
        console.error('WhatsApp message error:', err.message);
        try {
          if (currentSock) await currentSock.sendMessage(RABIH_JID, { text: 'Error: ' + err.message });
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
