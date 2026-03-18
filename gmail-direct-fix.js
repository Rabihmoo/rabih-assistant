// ============================================================
// GMAIL DIRECT INTEGRATION — Add this to your Railway index.js
// Bypasses n8n completely. Uses Google OAuth2 refresh token.
// ============================================================

const { google } = require('googleapis');

function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function readEmails(query = '', maxResults = 5) {
  const gmail = getGmailClient();
  const res = await gmail.users.messages.list({ userId: 'me', q: query, maxResults });
  if (!res.data.messages || res.data.messages.length === 0) return { count: 0, emails: [] };
  const emails = [];
  for (const msg of res.data.messages) {
    const detail = await gmail.users.messages.get({
      userId: 'me', id: msg.id, format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });
    const headers = detail.data.payload.headers;
    const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
    emails.push({
      id: msg.id,
      from: getHeader('From'),
      to: getHeader('To'),
      subject: getHeader('Subject'),
      date: getHeader('Date'),
      snippet: detail.data.snippet,
    });
  }
  return { count: emails.length, emails };
}

async function readEmailBody(messageId) {
  const gmail = getGmailClient();
  const detail = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'full' });
  const headers = detail.data.payload.headers;
  const getHeader = (name) => headers.find(h => h.name === name)?.value || '';
  let body = '';
  const payload = detail.data.payload;
  if (payload.body && payload.body.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
  } else if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart && textPart.body && textPart.body.data) {
      body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
    } else {
      const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
      if (htmlPart && htmlPart.body && htmlPart.body.data) {
        body = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8')
          .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
  }
  return {
    id: messageId,
    from: getHeader('From'), to: getHeader('To'),
    subject: getHeader('Subject'), date: getHeader('Date'),
    body: body.substring(0, 3000),
  };
}

async function sendEmail(to, subject, body) {
  const gmail = getGmailClient();
  const raw = Buffer.from(
    `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`
  ).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
  return { success: true, messageId: res.data.id };
}

const gmailTools = [
  {
    name: "read_emails",
    description: "Read recent emails from Gmail. Can filter by query like 'is:unread', 'from:someone@email.com', 'subject:invoice'. Returns subject, from, date, and snippet.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Gmail search query. Examples: 'is:unread', 'from:john@example.com', 'subject:report', empty string for all recent." },
        max_results: { type: "number", description: "How many emails to return. Default 5, max 20." }
      },
      required: []
    }
  },
  {
    name: "read_email_body",
    description: "Read the full body/content of a specific email by its message ID.",
    input_schema: {
      type: "object",
      properties: {
        message_id: { type: "string", description: "The Gmail message ID from read_emails results." }
      },
      required: ["message_id"]
    }
  },
  {
    name: "send_email",
    description: "Send an email from Rabih's Gmail account.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient email address" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body text" }
      },
      required: ["to", "subject", "body"]
    }
  }
];

async function handleGmailTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'read_emails': return await readEmails(toolInput.query || '', toolInput.max_results || 5);
      case 'read_email_body': return await readEmailBody(toolInput.message_id);
      case 'send_email': return await sendEmail(toolInput.to, toolInput.subject, toolInput.body);
      default: return { error: `Unknown Gmail tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`Gmail tool error (${toolName}):`, err.message);
    return { error: err.message };
  }
}

module.exports = { gmailTools, handleGmailTool, readEmails, readEmailBody, sendEmail };
