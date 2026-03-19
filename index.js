const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { gmailTools, handleGmailTool } = require('./gmail-direct-fix');
const { calendarTools, handleCalendarTool } = require('./calendar-direct-fix');
const { driveTools, handleDriveTool } = require('./drive-direct-fix');
const { filesTools, handleFilesTool } = require('./files-direct-fix');

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
  const parts = [
    'You are the personal AI assistant of Rabih Barakat. You work for him full-time.',
    'Today is ' + today + ', current time is ' + time + ' (Maputo time, UTC+2).',
    '',
    'About Rabih:',
    '- Lebanese businessman, owner of Rabih Group based in Maputo, Mozambique',
    '- Owns: BBQ House LDA, SALT LDA (restaurant/bar), Central Kitchen LDA, Executive Cleaning Services',
    '- Also owns Burgerury burger brand in Beirut, Lebanon',
    '- Speaks English and Arabic, sometimes mixes both',
    '- Direct person, gets things done, no unnecessary questions',
    '',
    'Your personality:',
    '- Real personal assistant, like a top-tier human EA',
    '- Concise, direct, warm',
    '- Reply in the same language Rabih uses',
    '- Never say you are an AI unless directly asked',
    '',
    'TOOL USAGE RULES:',
    '- ALWAYS use tools to complete requests - NEVER skip a tool call',
    '- NEVER confirm success unless the tool returned success:true or a valid result',
    '- If a tool fails, tell Rabih exactly what failed',
    '- You have FULL authority over Gmail, Calendar, and Drive',
    '- You CAN delete calendar events - use delete_calendar_event tool',
    '- You CAN read ANY file from Drive including .txt files - use read_file tool',
    '- You CAN send emails with content from files',
    '- NEVER say you cannot do something that your tools support',
    '- When asked for a file, ALWAYS call read_file and paste the full contents directly in your reply',
    '- NEVER tell Rabih to go to Drive manually - you fetch it yourself and show him the content',
    '- NEVER offer steps for Rabih to do himself when you have a tool that can do it',
    '- NEVER apologize or explain limitations - just use the tool and show the result',
    '',
    'DATA RULES:',
    '- NEVER invent or fabricate emails, events, files, or any data',
    '- Only report what tools actually returned',
    '- If results are empty, say exactly that'
  ];
  return parts.join('\n');
}

const TOOLS = [...calendarTools, ...gmailTools, ...driveTools, ...filesTools];

async function saveMessage(chatId, role, content) {
  try {
    const contentToStore = typeof content === 'string' ? content : JSON.stringify(content);
    const { error } = await supabase.from('assistant_messages').insert({
      chat_id: String(chatId),
      role: role,
      content: contentToStore
    });
    if (error) console.error('Save error:', error.message);
  } catch (e) {
    console.error('Save exception:', e.message);
  }
}

async function loadHistory(chatId) {
  try {
    const { data, error } = await supabase
      .from('assistant_messages')
      .select('role, content, created_at')
      .eq('chat_id', String(chatId))
      .order('created_at', { ascending: false })
      .limit(30);
    if (error) { console.error('Load history error:', error.message); return []; }
    return (data || []).reverse()
      .filter(function(r) { return r.content && r.content.indexOf('__dedup__') !== 0; })
      .map(function(r) {
        return {
          role: r.role,
          content: (function() { try { return JSON.parse(r.content); } catch (e) { return r.content; } })()
        };
      });
  } catch (e) {
    console.error('Load history exception:', e.message);
    return [];
  }
}

async function sendTelegram(chatId, text) {
  const url = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage';
  try {
    await axios.post(url, { chat_id: chatId, text: text, parse_mode: 'Markdown' });
  } catch (e) {
    try { await axios.post(url, { chat_id: chatId, text: text }); } catch (e2) { console.error('Telegram failed:', e2.message); }
  }
}

async function sendTyping(chatId) {
  await axios.post('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendChatAction', { chat_id: chatId, action: 'typing' }).catch(function() {});
}

async function executeTool(toolName, toolInput) {
  console.log('Executing tool:', toolName, JSON.stringify(toolInput));
  try {
    if (['read_emails', 'read_email_body', 'send_email'].includes(toolName)) return await handleGmailTool(toolName, toolInput);
    if (['list_calendar_events', 'create_calendar_event', 'delete_calendar_event'].includes(toolName)) return await handleCalendarTool(toolName, toolInput);
    if (['read_file', 'search_in_file', 'update_sheet_cell'].includes(toolName)) return await handleFilesTool(toolName, toolInput);
    if (['search_drive', 'list_drive_files', 'delete_drive_file'].includes(toolName)) return await handleDriveTool(toolName, toolInput);
    return { error: 'Unknown tool' };
  } catch (e) {
    console.error('Tool error:', e.message);
    return { error: e.message };
  }
}

async function callClaude(messages) {
  console.log('Calling Claude with', messages.length, 'messages...');
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 1024, system: buildSystemPrompt(), tools: TOOLS, messages: messages },
    { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
  );
  console.log('Claude stop_reason:', res.data.stop_reason);
  return res.data;
}

async function handleMessage(chatId, userText, messageId) {
  const dedupKey = '__dedup__' + String(messageId);

  const { data: existing } = await supabase
    .from('assistant_messages')
    .select('id')
    .eq('chat_id', String(chatId))
    .eq('content', dedupKey)
    .limit(1);

  if (existing && existing.length > 0) {
    console.log('Duplicate message ignored:', messageId);
    return;
  }

  await supabase.from('assistant_messages').insert({
    chat_id: String(chatId),
    role: 'user',
    content: dedupKey
  });

  if (userText.toLowerCase().trim() === '/reset' || userText.toLowerCase().trim() === 'reset memory') {
    await supabase.from('assistant_messages').delete().eq('chat_id', String(chatId));
    await sendTelegram(chatId, 'Memory cleared. Fresh start!');
    return;
  }

  await sendTyping(chatId);

  const history = await loadHistory(chatId);
  history.push({ role: 'user', content: userText });

  let response = await callClaude(history);
  let rounds = 0;

  while (response.stop_reason === 'tool_use' && rounds < 5) {
    rounds++;
    const toolUseBlocks = response.content.filter(function(b) { return b.type === 'tool_use'; });
    if (!toolUseBlocks.length) break;
    await sendTyping(chatId);
    history.push({ role: 'assistant', content: response.content });
    const toolResults = [];
    for (let i = 0; i < toolUseBlocks.length; i++) {
      const toolUse = toolUseBlocks[i];
      const result = await executeTool(toolUse.name, toolUse.input);
      toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
    }
    history.push({ role: 'user', content: toolResults });
    response = await callClaude(history);
  }

  const textBlock = response.content.find(function(b) { return b.type === 'text'; });
  const finalReply = textBlock ? textBlock.text : 'Done!';

  await saveMessage(chatId, 'user', userText);
  await saveMessage(chatId, 'assistant', finalReply);
  await sendTelegram(chatId, finalReply);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body && req.body.message;
    if (!msg || !msg.text) return;
    console.log('[' + msg.chat.id + '] ' + msg.text);
    await handleMessage(msg.chat.id, msg.text, msg.message_id);
  } catch (err) {
    const errMsg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message || 'Unknown error';
    console.error('Handler error:', errMsg);
    try { const chatId = req.body && req.body.message && req.body.message.chat && req.body.message.chat.id; if (chatId) await sendTelegram(chatId, 'Error: ' + errMsg); } catch (e) {}
  }
});

app.get('/', (req, res) => res.json({ status: 'Rabih Assistant running', tools: 'enabled' }));
app.listen(PORT, function() { console.log('Rabih Assistant listening on port ' + PORT); });
