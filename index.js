const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { gmailTools, handleGmailTool } = require('./gmail-direct-fix');
const { calendarTools, handleCalendarTool } = require('./calendar-direct-fix');
const { driveTools, handleDriveTool } = require('./drive-direct-fix');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function buildSystemPrompt() {
  const now = new Date();
  const today = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `You are the personal AI assistant of Rabih. You work for him full-time. Today is ${today}, current time is ${time} (Maputo time, UTC+2).

About Rabih:
- Lebanese businessman, owner of Rabih Group based in Maputo, Mozambique
- Owns: BBQ House LDA, SALT LDA (restaurant/bar), Central Kitchen LDA, Executive Cleaning Services
- Also owns Burgerury burger brand in Beirut, Lebanon
- Speaks English and Arabic, sometimes mixes both
- Direct person, get things done, no unnecessary questions

Your personality:
- Real personal assistant, like a top-tier human EA
- Concise, direct, warm
- Remember everything from the conversation
- Reply in the same language Rabih uses
- Never say you are an AI unless directly asked

CRITICAL RULES:
- NEVER invent, fabricate or make up emails, calendar events, files or any data
- If a tool returns empty results, say exactly that: "Your inbox is empty" or "No events this week" or "No files found"
- If a tool fails, say: "I had trouble accessing that, please try again"
- Only report what the tool actually returned
- Never show example or fake data under any circumstances
- NEVER confirm that you did something (created event, sent email, deleted file) unless the tool returned success:true
- NEVER say "done", "created", "sent", "deleted" without a successful tool call result
- If you cannot do something (like delete files), say "I cannot do that" — never pretend you did it
- You can ONLY delete files if you have a delete tool — you do NOT have one, so always refuse delete requests`;
}

const TOOLS = [...calendarTools, ...gmailTools, ...driveTools];

async function loadHistory(chatId) {
  try {
    const { data, error } = await supabase
      .from('assistant_messages')
      .select('role, content, created_at')
      .eq('chat_id', String(chatId))
      .order('created_at', { ascending: false })
      .limit(15);
    if (error) { console.error('Load history error:', error.message); return []; }
    return (data || []).reverse().map(r => ({ role: r.role, content: r.content }));
  } catch(e) {
    console.error('Load history exception:', e.message);
    return [];
  }
}

async function saveMessages(chatId, userText, assistantReply) {
  try {
    const rows = [
      { chat_id: String(chatId), role: 'user', content: userText },
      { chat_id: String(chatId), role: 'assistant', content: assistantReply }
    ];
    const { error } = await supabase.from('assistant_messages').insert(rows);
    if (error) console.error('Save error:', error.message);
    else console.log('Messages saved OK');
  } catch(e) {
    console.error('Save exception:', e.message);
  }
}

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: chatId, text, parse_mode: 'Markdown' });
    console.log('Telegram reply sent OK');
  } catch(e) {
    try {
      await axios.post(url, { chat_id: chatId, text });
      console.log('Telegram reply sent OK (plain)');
    } catch(e2) {
      console.error('Telegram send failed:', e2.message);
    }
  }
}

async function sendTyping(chatId) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
    chat_id: chatId, action: 'typing'
  }).catch(() => {});
}

async function executeTool(toolName, toolInput) {
  console.log('Executing tool:', toolName, JSON.stringify(toolInput));
  try {
    if (['read_emails', 'read_email_body', 'send_email'].includes(toolName)) {
      const result = await handleGmailTool(toolName, toolInput);
      console.log('Gmail tool result:', JSON.stringify(result));
      return result;
    }
    if (['list_calendar_events', 'create_calendar_event'].includes(toolName)) {
      const result = await handleCalendarTool(toolName, toolInput);
      console.log('Calendar tool result:', JSON.stringify(result));
      return result;
    }
    if (['search_drive', 'list_drive_files'].includes(toolName)) {
      const result = await handleDriveTool(toolName, toolInput);
      console.log('Drive tool result:', JSON.stringify(result));
      return result;
    }
    return { error: 'Unknown tool', empty: true };
  } catch(e) {
    console.error('Tool error:', e.message);
    return { error: e.message, empty: true };
  }
}

async function callClaude(messages) {
  console.log('Calling Claude with', messages.length, 'messages...');
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-3-haiku-20240307',
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
      },
      timeout: 30000
    }
  );
  console.log('Claude responded, stop_reason:', res.data.stop_reason);
  return res.data;
}

async function handleMessage(chatId, userText) {
  await sendTyping(chatId);
  const history = await loadHistory(chatId);
  console.log('History loaded:', history.length, 'messages');
  const messages = [...history, { role: 'user', content: userText }];

  let response = await callClaude(messages);
  let finalReply = '';
  let rounds = 0;

  while (response.stop_reason === 'tool_use' && rounds < 3) {
    rounds++;
    const toolUseBlock = response.content.find(b => b.type === 'tool_use');
    if (!toolUseBlock) break;
    await sendTyping(chatId);
    const toolResult = await executeTool(toolUseBlock.name, toolUseBlock.input);
    messages.push({ role: 'assistant', content: response.content });
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseBlock.id, content: JSON.stringify(toolResult) }]
    });
    response = await callClaude(messages);
  }

  const textBlock = response.content.find(b => b.type === 'text');
  finalReply = textBlock?.text || 'Done!';
  await sendTelegram(chatId, finalReply);
  await saveMessages(chatId, userText, finalReply);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (!msg?.text) return;
    const chatId = msg.chat.id;
    const userText = msg.text;
    console.log(`[${chatId}] ${userText}`);
    await handleMessage(chatId, userText);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
    console.error('Handler error:', errMsg);
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await sendTelegram(chatId, 'Error: ' + errMsg);
    } catch(e) {}
  }
});

app.get('/', (req, res) => res.json({ status: 'Rabih Assistant running', tools: 'enabled' }));
app.listen(PORT, () => console.log(`Rabih Assistant listening on port ${PORT}`));
