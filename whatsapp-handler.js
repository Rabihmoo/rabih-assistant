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
let processingStartTime = null;
let lastConnectedNotify = 0;
let _reconnect = null;
let badMacCount = 0;
let lastBadMacReset = Date.now();
const sentMessages = new Set();
const processedMessages = new Set();

const RABIH_NUMBER = '258875254847';

// ====== RATE LIMITING & HUMAN-LIKE SENDING ======
const MSG_HOUR_LIMIT = 20;
const hourlyMessages = [];

function canSendMessage() {
  var now = Date.now();
  // Remove entries older than 1 hour
  while (hourlyMessages.length > 0 && hourlyMessages[0] < now - 3600000) {
    hourlyMessages.shift();
  }
  return hourlyMessages.length < MSG_HOUR_LIMIT;
}

function recordMessageSent() {
  hourlyMessages.push(Date.now());
}

function randomDelay() {
  // 2-3 second random delay
  return 2000 + Math.floor(Math.random() * 1000);
}

function typingDuration(text) {
  // Simulate typing: ~50ms per character, min 1s, max 4s
  if (!text) return 1000;
  var ms = Math.min(4000, Math.max(1000, text.length * 50));
  return ms;
}

async function safeSendMessage(jid, content) {
  if (!currentSock) return null;
  if (!canSendMessage()) {
    console.log('RATE LIMIT — max ' + MSG_HOUR_LIMIT + '/hour reached, skipping send to', jid);
    return null;
  }
  // Random delay before sending
  await new Promise(function(r) { setTimeout(r, randomDelay()); });
  // Simulate typing
  var text = content.text || '';
  try { await currentSock.sendPresenceUpdate('composing', jid); } catch(e) {}
  await new Promise(function(r) { setTimeout(r, typingDuration(text)); });
  try { await currentSock.sendPresenceUpdate('paused', jid); } catch(e) {}
  // Send
  var sent = await currentSock.sendMessage(jid, content);
  recordMessageSent();
  return sent;
}
// ================================================

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
  // Also clear old auth session so Baileys requests a fresh QR
  try {
    fs.rmSync(AUTH_FOLDER, { recursive: true, force: true });
    console.log('Auth folder cleared + QR flag cleared — will reconnect fresh');
  } catch(e) {
    console.log('QR flag cleared (auth folder clear failed:', e.message, ')');
  }
  // Force disconnect and reconnect
  if (currentSock) {
    try { currentSock.end(); } catch(e) {}
    currentSock = null;
  }
  // Trigger fresh connection after a short delay
  if (_reconnect) setTimeout(_reconnect, 3000);
}

function getWhatsAppSocket() {
  return currentSock;
}

// Options: { telegramToken, rabihChatId, onRabihMessage, onOtherMessage, onVoiceMessage }
async function initWhatsApp(options) {
  const logger = pino({ level: 'fatal' }).child({ module: 'baileys' });
  logger.level = 'fatal';
  const telegramToken = options.telegramToken;
  const rabihChatId = options.rabihChatId;
  const onRabihMessage = options.onRabihMessage;
  const onOtherMessage = options.onOtherMessage;
  const onVoiceMessage = options.onVoiceMessage;
  const RABIH_JID = '258875254847@s.whatsapp.net';

  async function connect() {
    _reconnect = connect;
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER, logger);
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
    // Wrap saveCreds to suppress any internal logging of auth objects (Buffer keys etc)
    sock.ev.on('creds.update', function() {
      try { saveCreds(); } catch(e) {}
    });

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
        badMacCount = 0;
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
        const errorMsg = lastDisconnect && lastDisconnect.error && lastDisconnect.error.message || '';
        const isBadMac = errorMsg.includes('Bad MAC') || errorMsg.includes('bad mac');
        console.log('WhatsApp disconnected, code:', statusCode, 'error:', errorMsg, 'reconnecting:', statusCode !== DisconnectReason.loggedOut);

        // Handle Bad MAC errors — corrupted session, needs fresh auth
        if (isBadMac) {
          badMacCount++;
          console.error('Bad MAC error #' + badMacCount + ' — session corrupted');
          if (badMacCount >= 3) {
            console.log('Too many Bad MAC errors — clearing auth and requesting new QR');
            badMacCount = 0;
            try { fs.rmSync(AUTH_FOLDER, { recursive: true, force: true }); } catch(e) {}
            clearQRSent();
            await axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
              chat_id: rabihChatId,
              text: 'WhatsApp session corrupted (Bad MAC). Cleared auth — a new QR code will be sent shortly. Please scan it.'
            }).catch(function() {});
            setTimeout(connect, 3000);
            return;
          }
        }

        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        if (shouldReconnect) {
          console.log('Reconnecting in 30 seconds...');
          setTimeout(connect, 30000);
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

    // Catch session/crypto errors that don't trigger connection close
    sock.ev.on('error', function(err) {
      var errStr = (err && err.message) || String(err);
      if (errStr.includes('Bad MAC') || errStr.includes('bad mac')) {
        badMacCount++;
        console.error('Socket error Bad MAC #' + badMacCount);
        if (badMacCount >= 3) {
          console.log('Forcing session reset due to repeated Bad MAC');
          forceNewQR();
          axios.post('https://api.telegram.org/bot' + telegramToken + '/sendMessage', {
            chat_id: rabihChatId,
            text: 'WhatsApp session corrupted (repeated Bad MAC errors). Clearing session — new QR coming.'
          }).catch(function() {});
          badMacCount = 0;
        }
      }
    });

    sock.ev.on('messages.upsert', async function(m) {
      var from = null;
      var msg = null;
      try { // Outer safety — catch absolutely everything
      try {
        if (m.type !== 'notify') return;
        msg = m.messages[0];
        if (!msg) return;
        if (!msg.message) return;

        from = msg.key.remoteJid;
        var messageId = msg.key.id;

        // Skip group messages
        if (from.endsWith('@g.us') || from.endsWith('@broadcast')) {
          return;
        }

        // Skip ALL outgoing messages (fromMe) — Rabih talks to the bot via Telegram,
        // not by sending WhatsApp messages. Without this, when Rabih manually texts a
        // contact, the bot treats it as a command, generates a Claude reply, and sends
        // it to the contact's chat. This caused the "Deal ✅ أنا هون يا رابح" bug.
        if (msg.key.fromMe === true) {
          return;
        }

        var isFromRabih = from.includes(RABIH_NUMBER);

        // Dedup checks
        if (processedMessages.has(messageId)) return;
        processedMessages.add(messageId);
        setTimeout(function() { processedMessages.delete(messageId); }, 60000);

        if (sentMessages.has(messageId)) {
          sentMessages.delete(messageId);
          return;
        }

        // Prevent concurrent processing (with 90s safety timeout to prevent permanent lock)
        if (isProcessing) {
          if (processingStartTime && (Date.now() - processingStartTime > 90000)) {
            console.log('FORCE UNLOCKING isProcessing — stuck for >90s');
            isProcessing = false; processingStartTime = null;
          } else {
            console.log('Skipping message — already processing:', (from || '').substring(0, 20));
            return;
          }
        }

        // Check if it's a voice/audio message
        var audioMsg = msg.message.audioMessage;
        if (audioMsg && onVoiceMessage) {
          console.log('WhatsApp voice message from ' + from);
          isProcessing = true; processingStartTime = Date.now();
          try {
            var audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: logger, reuploadRequest: sock.updateMediaMessage });
            var response = await onVoiceMessage(audioBuffer, audioMsg.mimetype || 'audio/ogg', from, isFromRabih);
            if (response && currentSock) {
              var sent = await safeSendMessage(from, { text: response });
              if (sent && sent.key && sent.key.id) {
                sentMessages.add(sent.key.id);
                processedMessages.add(sent.key.id);
                setTimeout(function() { sentMessages.delete(sent.key.id); }, 60000);
                setTimeout(function() { processedMessages.delete(sent.key.id); }, 60000);
              }
            }
          } finally {
            isProcessing = false; processingStartTime = null;
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

        console.log('WhatsApp message from ' + from + ' (rabih:' + isFromRabih + '): ' + text.substring(0, 80));

        isProcessing = true;
        try {
          if (isFromRabih) {
            // Rabih's own message — full assistant mode
            var response = await onRabihMessage(text, 'whatsapp', from);
            if (response && currentSock) {
              var sent = await safeSendMessage(from, { text: response });
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
              var sent = await safeSendMessage(from, { text: reply });
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
          isProcessing = false; processingStartTime = null;
        }
      } catch (err) {
        isProcessing = false; processingStartTime = null;
        console.error('WhatsApp message error:', err.message);
        try {
          // Only ever send error messages to Rabih
          var errIsRabih = from && (from.includes(RABIH_NUMBER) || (msg && msg.key && msg.key.fromMe === true));
          if (currentSock && from && errIsRabih) {
            await safeSendMessage(from, { text: 'Error: ' + err.message });
          }
        } catch(e) {}
      }
      } catch (outerErr) {
        // Absolute last resort — never let the process crash from a message
        isProcessing = false; processingStartTime = null;
        console.error('CRITICAL — outer catch in messages.upsert:', outerErr.message);
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

module.exports = { initWhatsApp: initWhatsApp, getWhatsAppSocket: getWhatsAppSocket, forceNewQR: forceNewQR, safeSendMessage: safeSendMessage };
