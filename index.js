const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const PORT           = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── System prompt ────────────────────────────────────────────────────────────
function buildSystemPrompt() {
  const now   = new Date();
  const today = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time  = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return `You are the personal AI assistant of Rabih. You work for him full-time.

Today is ${today}, current time is ${time} (Maputo time, UTC+2).

About Rabih:
- Lebanese businessman based in Maputo, Mozambique
- Runs Rabih Group: BBQ House LDA, SALT LDA (restaurant/bar), Central Kitchen LDA, Executive Cleaning Services
- Also owns Burgerury burger brand in Beirut, Lebanon
- Speaks English and Arabic, sometimes mixes both
- Direct person — get things done, no unnecessary questions

Your personality:
- Real personal assistant, like a top-tier human EA
- Concise, direct, warm
- Take initiative — if he says "remind me meeting with Fadi tomorrow at 10" you set it immediately
- Remember everything from the conversation
- Reply in the same language Rabih uses (English or Arabic)
- Never say you are an AI unless directly asked

Tools available:
- create_calendar_event: add meetings, reminders, events to Google Calendar
- list_calendar_events: check his schedule
- send_email: send emails via Gmail
- read_emails: check his inbox
- search_drive: find files in Google Drive
- list_drive_files: browse recent Drive files`;
}

// ─── Tools definition ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'create_calendar_event',
    description: 'Create an event or reminder in Google Calendar.',
    input_schema: {
      type: 'object',
      properties: {
        title:            { type: 'string',  description: 'Event title' },
        date:             { type: 'string',  description: 'Date in YYYY-MM-DD format' },
        time:             { type: 'string',  description: 'Time in HH:MM 24h format' },
        duration_minutes: { type: 'number',  description: 'Duration in minutes, default 60' },
        is_reminder:      { type: 'boolean', description: 'True if this is a reminder' }
      },
      required: ['title', 'date', 'time']
    }
  },
  {
    name: 'list_calendar_events',
    description: 'List upcoming calendar events.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'number', description: 'How many days ahead to look, default 7' }
      }
    }
  },
  {
    name: 'send_email',
    description: 'Send an email via Gmail.',
    input_schema: {
      type: 'object',
      properties: {
        to:      { type: 'string', description: 'Recipient email' },
        subject: { type: 'string', description: 'Subject line' },
        body:    { type: 'string', description: 'Email body' }
      },
      required: ['to', 'subject', 'body']
    }
  },
  {
    name: 'read_emails',
    description: 'Read recent emails from inbox.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of emails, default 5' }
      }
    }
  },
  {
    name: 'search_drive',
    description: 'Search for files in Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or filename' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_drive_files',
    description: 'List recent files in Google Drive.',
    input_schema: { type: 'object', properties: {} }
  }
];

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function loadHistory(chatId) {
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('role, content, created_at')
    .eq('chat_id', String(chatId))
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) { console.error('Load history error:', error); return []; }

  return (data || [])
    .reverse()
    .map(r => ({ role: r.role, content: r.content }));
}

async function saveMessages(chatId, userText, assistantReply) {
  const rows = [
    { chat_id: String(chatId), role: 'user',      content: userText },
    { chat_id: String(chatId), role: 'assistant', content: assistantReply }
  ];
  const { error } = await supabase.from('assistant_messages').insert(rows);
  if (error) console.error('Save messages error:', error);
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────
async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await axios.post(url, {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown'
  }).catch(e => {
    // retry without markdown if it fails
    return axios.post(url, { chat_id: chatId, text });
  });
}

async function sendTyping(chatId) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
    chat_id: chatId, action: 'typing'
  }).catch(() => {});
}

// ─── Google Calendar via n8n webhook ─────────────────────────────────────────
// We call n8n only for actual Google API actions — not for conversation
const N8N_WEBHOOK = process.env.N8N_TOOL_WEBHOOK; // optional

async function executeTool(toolName, toolInput) {
  console.log(`Executing tool: ${toolName}`, toolInput);

  if (!N8N_WEBHOOK) {
    return { error: 'Tool execution not configured yet', tool: toolName };
  }

  try {
    const res = await axios.post(N8N_WEBHOOK, { tool: toolName, input: toolInput }, { timeout: 15000 });
    return res.data;
  } catch (e) {
    console.error('Tool execution error:', e.message);
    return { error: e.message };
  }
}

// ─── Claude API call ──────────────────────────────────────────────────────────
async function callClaude(messages) {
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 1024,
      system: buildSystemPrompt(),
      tools: TOOLS,
      messages
    },
    {
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      }
    }
  );
  return res.data;
}

// ─── Main message handler ─────────────────────────────────────────────────────
async function handleMessage(chatId, userText) {
  // Show typing indicator
  await sendTyping(chatId);

  // Load history
  const history = await loadHistory(chatId);

  // Build messages
  const messages = [
    ...history,
    { role: 'user', content: userText }
  ];

  // First Claude call
  let response = await callClaude(messages);
  let finalReply = '';

  // Handle tool use (max 3 rounds to avoid infinite loops)
  let rounds = 0;
  while (response.stop_reason === 'tool_use' && rounds < 3) {
    rounds++;

    const toolUseBlock = response.content.find(b => b.type === 'tool_use');
    if (!toolUseBlock) break;

    console.log(`Tool call: ${toolUseBlock.name}`, toolUseBlock.input);

    // Execute the tool
    const toolResult = await executeTool(toolUseBlock.name, toolUseBlock.input);

    // Add assistant + tool_result to messages
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseBlock.id,
        content: JSON.stringify(toolResult)
      }]
    });

    // Call Claude again with tool result
    await sendTyping(chatId);
    response = await callClaude(messages);
  }

  // Extract final text reply
  const textBlock = response.content.find(b => b.type === 'text');
  finalReply = textBlock?.text || 'Done!';

  // Send reply to Telegram
  await sendTelegram(chatId, finalReply);

  // Save to memory
  await saveMessages(chatId, userText, finalReply);
}

// ─── Webhook endpoint ─────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // always ack Telegram immediately

  try {
    const msg = req.body?.message;
    if (!msg?.text) return;

    const chatId   = msg.chat.id;
    const userText = msg.text;

    console.log(`[${chatId}] ${userText}`);
    await handleMessage(chatId, userText);
  } catch (err) {
    console.error('Handler error:', err.message);
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Rabih Assistant running' }));

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Rabih Assistant listening on port ${PORT}`));
