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
let lastConnectedNotify = 0;
let _reconnect = null;
let badMacCount = 0;

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

// Options: { telegramToken, rabihChatId }
// Baileys stays connected for outbound sends only. No incoming message processing.
async function initWhatsApp(options) {
  const logger = pino({ level: 'fatal' }).child({ module: 'baileys' });
  logger.level = 'fatal';
  const telegramToken = options.telegramToken;
  const rabihChatId = options.rabihChatId;

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

    // Incoming messages: log only, never process or reply.
    // Baileys stays connected solely for outbound sends via send_whatsapp_message tool.
    sock.ev.on('messages.upsert', function(m) {
      try {
        if (m.type !== 'notify') return;
        var msg = m.messages && m.messages[0];
        if (!msg || !msg.message) return;
        if (msg.key.fromMe) return; // ignore our own outgoing messages
        var from = msg.key.remoteJid || '';
        if (from.endsWith('@g.us') || from.endsWith('@broadcast')) return;
        var text = (msg.message.conversation) ||
          (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text) ||
          (msg.message.audioMessage ? '[voice]' : '[media]');
        console.log('WA ignored:', from.substring(0, 20), String(text).substring(0, 60));
      } catch(e) {}
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
