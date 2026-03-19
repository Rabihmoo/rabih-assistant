const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { gmailTools, handleGmailTool } = require('./gmail-direct-fix');
const { calendarTools, handleCalendarTool } = require('./calendar-direct-fix');
const { driveTools, handleDriveTool } = require('./drive-direct-fix');
const { filesTools, handleFilesTool } = require('./files-direct-fix');
const { expenseTools, handleExpenseTool } = require('./expense-tracker');
const { reminderTools, handleReminderTool } = require('./reminders');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = process.env.PORT || 3000;
const RABIH_CHAT_ID = '5140288064';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Load persistent memory facts about Rabih
async function loadMemory() {
  try {
    const { data } = await supabase
      .from('rabih_memory')
      .select('fact')
      .order('created_at', { ascending: true });
    return (data || []).map(function(r) { return r.fact; });
  } catch (e) {
    return [];
  }
}

// Save a new memory fact
async function saveMemory(fact) {
  try {
    await supabase.from('rabih_memory').insert({ fact: fact });
  } catch (e) {
    console.error('Memory save error:', e.message);
  }
}

// Extract and save important facts from a conversation
async function extractAndSaveMemory(userText, assistantReply) {
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            'Extract any important personal facts, preferences, names, decisions, or business info from this conversation.',
            'Only extract facts worth remembering long-term. Return each fact on a new line starting with "FACT:".',
            'If nothing important, return "NONE".',
            '',
            'User said: ' + userText,
            'Assistant replied: ' + assistantReply
          ].join('\n')
        }]
      },
      { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    const text = res.data.content[0].text;
    if (text && text !== 'NONE') {
      const lines = text.split('\n').filter(function(l) { return l.startsWith('FACT:'); });
      for (let i = 0; i < lines.length; i++) {
        const fact = lines[i].replace('FACT:', '').trim();
        if (fact) await saveMemory(fact);
      }
    }
  } catch (e) {
    console.error('Memory extraction error:', e.message);
  }
}

function buildSystemPrompt(memoryFacts) {
  const now = new Date();
  const today = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const parts = [
    'You are the personal AI assistant of Rabih Barakat. You work for him full-time like a trusted friend and EA.',
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
    '- You are like a smart trusted friend who knows Rabih deeply',
    '- Concise, direct, warm - adapt your tone to how he talks',
    '- Reply in the same language Rabih uses',
    '- Never say you are an AI unless directly asked',
    '- Remember everything, never ask him to repeat himself',
    '- Anticipate what he needs based on context',
    '',
    'TOOL USAGE RULES:',
    '- ALWAYS use tools to complete requests - NEVER skip a tool call',
    '- NEVER confirm success unless the tool returned success:true or a valid result',
    '- If a tool fails, tell Rabih exactly what failed',
    '- You have FULL authority over Gmail, Calendar, Drive, and all tools',
    '- You CAN delete calendar events - use delete_calendar_event tool',
    '- You CAN read ANY file from Drive including .txt files',
    '- You CAN search the web for research - use web_search tool',
    '- NEVER say you cannot do something that your tools support',
    '- When asked for a file, ALWAYS call read_file and paste contents directly',
    '- NEVER tell Rabih to do things manually when you have a tool',
    '- NEVER apologize or explain limitations - just use the tool',
    '- For research: search web, summarize, then act (email etc) without asking',
    '',
    'DATA RULES:',
    '- NEVER invent or fabricate any data',
    '- Only report what tools actually returned',
    '- If results are empty, say exactly that'
  ];

  if (memoryFacts && memoryFacts.length > 0) {
    parts.push('');
    parts.push('WHAT YOU REMEMBER ABOUT RABIH (from past conversations):');
    for (let i = 0; i < memoryFacts.length; i++) {
      parts.push('- ' + memoryFacts[i]);
    }
  }

  return parts.join('\n');
}

const TOOLS = [
  ...calendarTools,
  ...gmailTools,
  ...driveTools,
  ...filesTools,
  ...expenseTools,
  ...reminderTools,
  { type: 'web_search_20250305', name: 'web_search' }
];

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
      .limit(50);
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
    if (['search_drive', 'list_drive_files', 'delete_drive_file', 'rename_drive_file'].includes(toolName)) return await handleDriveTool(toolName, toolInput);
    if (['log_expense', 'get_expense_summary'].includes(toolName)) return await handleExpenseTool(toolName, toolInput);
    if (['set_reminder', 'add_supplier', 'find_supplier'].includes(toolName)) return await handleReminderTool(toolName, toolInput);
    return { error: 'Unknown tool' };
  } catch (e) {
    console.error('Tool error:', e.message);
    return { error: e.message };
  }
}

async function callClaude(messages, memoryFacts) {
  console.log('Calling Claude with', messages.length, 'messages...');
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: 'claude-sonnet-4-6', max_tokens: 4096, system: buildSystemPrompt(memoryFacts || []), tools: TOOLS, messages: messages },
    { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 60000 }
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

  if (userText.toLowerCase().trim() === '/reset') {
    await supabase.from('assistant_messages').delete().eq('chat_id', String(chatId));
    await sendTelegram(chatId, 'Chat history cleared. Memory facts kept.');
    return;
  }

  if (userText.toLowerCase().trim() === '/resetall') {
    await supabase.from('assistant_messages').delete().eq('chat_id', String(chatId));
    await supabase.from('rabih_memory').delete().neq('id', 0);
    await sendTelegram(chatId, 'Everything cleared. Fresh start!');
    return;
  }

  if (userText.toLowerCase().trim() === '/memory') {
    const facts = await loadMemory();
    if (facts.length === 0) {
      await sendTelegram(chatId, 'No memories saved yet.');
    } else {
      await sendTelegram(chatId, 'What I remember about you:\n\n' + facts.map(function(f, i) { return (i+1) + '. ' + f; }).join('\n'));
    }
    return;
  }

  await sendTyping(chatId);

  const [history, memoryFacts] = await Promise.all([
    loadHistory(chatId),
    loadMemory()
  ]);

  history.push({ role: 'user', content: userText });

  let response = await callClaude(history, memoryFacts);
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
    response = await callClaude(history, memoryFacts);
  }

  const textBlock = response.content.find(function(b) { return b.type === 'text'; });
  const finalReply = textBlock ? textBlock.text : 'Done!';

  await saveMessage(chatId, 'user', userText);
  await saveMessage(chatId, 'assistant', finalReply);
  await sendTelegram(chatId, finalReply);

  // Extract and save memory in background - don't await
  extractAndSaveMemory(userText, finalReply).catch(function() {});
}

async function handleMediaMessage(chatId, messages) {
  try {
    await sendTyping(chatId);
    const memoryFacts = await loadMemory();
    const response = await callClaude(messages, memoryFacts);
    const textBlock = response.content.find(function(b) { return b.type === 'text'; });
    await sendTelegram(chatId, textBlock ? textBlock.text : 'Could not process this file.');
  } catch (err) {
    console.error('Media handler error:', err.message);
    await sendTelegram(chatId, 'Error processing file: ' + err.message);
  }
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body && req.body.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    // Handle photos
    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      const caption = msg.caption || 'What is in this image? Describe and analyze it fully.';
      const fileRes = await axios.get('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getFile?file_id=' + photo.file_id);
      const filePath = fileRes.data.result.file_path;
      const imageRes = await axios.get('https://api.telegram.org/file/bot' + TELEGRAM_TOKEN + '/' + filePath, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(imageRes.data).toString('base64');
      const messages = [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: caption }
      ]}];
      await handleMediaMessage(chatId, messages);
      return;
    }

    // Handle documents
    if (msg.document) {
      const doc = msg.document;
      const caption = msg.caption || 'Read and summarize this document fully.';
      const fileRes = await axios.get('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getFile?file_id=' + doc.file_id);
      const filePath = fileRes.data.result.file_path;
      const docRes = await axios.get('https://api.telegram.org/file/bot' + TELEGRAM_TOKEN + '/' + filePath, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(docRes.data).toString('base64');
      const mediaType = doc.mime_type || 'application/pdf';
      const messages = [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: caption }
      ]}];
      await handleMediaMessage(chatId, messages);
      return;
    }

    if (!msg.text) return;
    console.log('[' + chatId + '] ' + msg.text);
    await handleMessage(chatId, msg.text, messageId);
  } catch (err) {
    const errMsg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message || 'Unknown error';
    console.error('Handler error:', errMsg);
    try { const chatId = req.body && req.body.message && req.body.message.chat && req.body.message.chat.id; if (chatId) await sendTelegram(chatId, 'Error: ' + errMsg); } catch (e) {}
  }
});

// Morning briefing - every day at 7:00 AM Maputo time
setInterval(async function() {
  const now = new Date();
  const maputoHour = (now.getUTCHours() + 2) % 24;
  const maputoMin = now.getUTCMinutes();
  if (maputoHour === 7 && maputoMin === 0) {
    console.log('Sending morning briefing...');
    try {
      const memoryFacts = await loadMemory();
      const history = [{ role: 'user', content: 'Good morning! Give me my morning briefing: 1) My calendar events for today and tomorrow 2) Any unread important emails from the last 12 hours. Be concise and direct.' }];
      let response = await callClaude(history, memoryFacts);
      let rounds = 0;
      while (response.stop_reason === 'tool_use' && rounds < 5) {
        rounds++;
        const toolUseBlocks = response.content.filter(function(b) { return b.type === 'tool_use'; });
        if (!toolUseBlocks.length) break;
        history.push({ role: 'assistant', content: response.content });
        const toolResults = [];
        for (let i = 0; i < toolUseBlocks.length; i++) {
          const toolUse = toolUseBlocks[i];
          const result = await executeTool(toolUse.name, toolUse.input);
          toolResults.push({ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) });
        }
        history.push({ role: 'user', content: toolResults });
        response = await callClaude(history, memoryFacts);
      }
      const textBlock = response.content.find(function(b) { return b.type === 'text'; });
      const briefing = textBlock ? textBlock.text : 'Good morning Rabih!';
      await sendTelegram(RABIH_CHAT_ID, 'Good morning Rabih!\n\n' + briefing);
    } catch (err) {
      console.error('Morning briefing error:', err.message);
    }
  }
}, 60000);

app.get('/', (req, res) => res.json({ status: 'Rabih Assistant running', tools: 'enabled' }));
app.listen(PORT, function() { console.log('Rabih Assistant listening on port ' + PORT); });
