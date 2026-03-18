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
  return `You are the personal AI assistant of Rabih Barakat. You work for him full-time. Today is ${today}, current time is ${time} (Maputo time, UTC+2).

About Rabih:
- Lebanese businessman, owner of Rabih Group based in Maputo, Mozambique
- Owns: BBQ House LDA, SALT LDA (restaurant/bar), Central Kitchen LDA, Executive Cleaning Services
- Also owns Burgerury burger brand in Beirut, Lebanon
- Speaks English and Arabic, sometimes mixes both
- Direct person, gets things done, no unnecessary questions

Your personality:
- Real personal assistant, like a top-tier human EA
- Concise, direct, warm
- Reply in the same language Rabih uses
- Never say you are an AI unless directly asked

TOOL USAGE RULES - READ CAREFULLY:
- ALWAYS use tools to complete requests — NEVER skip a tool call and pretend you did something
- NEVER confirm success unless the tool returned success:true or a valid result
- NEVER say "done", "created", "sent", "deleted", "I've set up..." without a successful tool result
- If a tool fails, tell Rabih exactly what failed — never hide errors
- For calendar: ALWAYS call create_calendar_event — never confirm without calling it
- For email: ALWAYS call send_email — never confirm without calling it
- For drive delete: ALWAYS call delete_drive_file — never confirm without calling it
- If you cannot do something, say so directly: "I can't do that"

DATA RULES:
- NEVER invent or fabricate emails, events, files, or any data
- Only report what tools actually returned
- If results are empty, say exactly that`;
}

const TOOLS = [...calendarTools, ...gmailTools, ...driveTools];

async function loadHistory(chatId) {
  try {
    const { data, error } = await supabase
      .from('assistant_messages')
      .select('role, content, created_at')
      .eq('chat_id', String(chatId))
      .order('created_at', { ascending: false })
      .limit(20);
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
      console.log('Gmail result:', JSON.stringify(result));
      return result;
    }
    if (['list_calendar_events', 'create_calendar_event'].includes(toolName)) {
      const result = await handleCalendarTool(toolName, toolInput);
      console.log('Calendar result:', JSON.stringify(result));
      return result;
    }
    if (['search_drive', 'list_drive_files', 'delete_drive_file'].includes(toolName)) {
      const result = await handleDriveTool(toolName, toolInput);
      console.log('Drive result:', JSON.stringify(result));
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
      model: 'claude-haiku-4-5-20251001',
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
  // Auto-clear memory command
  if (userText.toLowerCase().trim() === '/reset' || userText.toLowerCase().trim() === 'reset memory') {
    await supabase.from('assistant_messages').delete().eq('chat_id', String(chatId));
    await sendTelegram(chatId, '✅ Memory cleared. Fresh start!');
    return;
  }

  await sendTyping(chatId);
  const history = await loadHistory(chatId);
  console.log('History loaded:', history.length, 'messages');
  const messages = [...history, { role: 'user', content: userText }];

  let response = await callClaude(messages);
  let finalReply = '';
  let rounds = 0;

  while (response.stop_reason === 'tool_use' && rounds < 5) {
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
      if (chatId) await sendTelegram(chatId, '❌ Error: ' + errMsg);
    } catch(e) {}
  }
});

app.get('/', (req, res) => res.json({ status: 'Rabih Assistant running', tools: 'enabled' }));
app.listen(PORT, () => console.log(`Rabih Assistant listening on port ${PORT}`));
