// v5 — Full upgrade: contacts, scheduler, tasks, voice, invoices, location, news, multi-person WhatsApp

// Prevent crashes from killing the server
process.on('uncaughtException', function(err) {
  console.error('Uncaught exception:', err.message, err.stack);
});
process.on('unhandledRejection', function(err) {
  console.error('Unhandled rejection:', err && err.message ? err.message : err);
});
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { gmailTools, handleGmailTool } = require('./gmail-direct-fix');
const { calendarTools, handleCalendarTool } = require('./calendar-direct-fix');
const { driveTools, handleDriveTool } = require('./drive-direct-fix');
const { filesTools, handleFilesTool } = require('./files-direct-fix');
const { expenseTools, handleExpenseTool } = require('./expense-tracker');
const { reminderTools, handleReminderTool } = require('./reminders');
const { communicationTools, handleCommunicationTool, setSocket, setSafeSend } = require('./communication-tools');
const { contactsTools, handleContactTool, isApprovedContact } = require('./contacts');
const { taskTools, handleTaskTool, getPendingTasksSummary } = require('./task-manager');
const { schedulerTools, handleSchedulerTool, initScheduler } = require('./scheduler');
const { invoiceTools, handleInvoiceTool, getOverdueInvoices } = require('./invoice-tracker');
const { locationTools, handleLocationTool } = require('./location-tools');
const { newsTools, handleNewsTool } = require('./news-tools');
const { transcribeAudio } = require('./voice-handler');
const { checklistTools, handleChecklistTool, initChecklists, processChecklistResponse } = require('./checklist-manager');
const { initWhatsApp, forceNewQR, safeSendMessage } = require('./whatsapp-handler');

const app = express();
app.use(express.json());
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Serve dashboard
app.use(express.static(__dirname));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PORT = process.env.PORT || 3000;
const RABIH_CHAT_ID = '5140288064';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Check wa_enabled from Supabase — returns true only if value is exactly 'true'
async function isWaEnabledInDb() {
  try {
    var { data } = await supabase.from('assistant_settings').select('value').eq('key', 'wa_enabled').limit(1).single();
    return data && data.value === 'true';
  } catch(e) { return false; }
}

// Log wa_enabled on startup
isWaEnabledInDb().then(function(enabled) {
  console.log('STARTUP — wa_enabled in Supabase:', enabled);
});

// ========================= MEMORY =========================

async function loadMemory() {
  try {
    const { data } = await supabase.from('rabih_memory').select('fact').order('created_at', { ascending: true });
    return (data || []).map(function(r) { return r.fact; });
  } catch (e) { return []; }
}

async function saveMemory(fact) {
  try { await supabase.from('rabih_memory').insert({ fact: fact }); }
  catch (e) { console.error('Memory save error:', e.message); }
}

async function extractAndSaveMemory(userText, assistantReply) {
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-haiku-4-5-20251001', max_tokens: 500, messages: [{ role: 'user', content: [
        'Extract any important personal facts, preferences, names, decisions, or business info from this conversation.',
        'Only extract facts worth remembering long-term. Return each fact on a new line starting with FACT:',
        'If nothing important, return NONE.',
        '',
        'User said: ' + userText,
        'Assistant replied: ' + assistantReply
      ].join('\n') }] },
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
  } catch (e) { console.error('Memory extraction error:', e.message); }
}

// ========================= SYSTEM PROMPT =========================

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
    '- Concise, direct, warm — a little funny sometimes, never robotic',
    '- Reply in the same language Rabih uses',
    '- Never say you are an AI unless directly asked',
    '- Remember everything, never ask him to repeat himself',
    '- Anticipate what he needs based on context',
    '- NEVER use bullet points, numbered lists, or markdown formatting in WhatsApp replies — just natural flowing text like a real person texting',
    '- Keep replies short and to the point, like texting a friend',
    '',
    'TOOL USAGE RULES — ABSOLUTE, NO EXCEPTIONS:',
    'CRITICAL: You MUST call the actual tool. Never say you sent a message, created a task, or did anything without calling the tool first. If you cannot call a tool, say you cannot — never pretend you did.',
    '- You MUST call tools to perform actions. NEVER just say you did something — actually do it by calling the tool.',
    '- If Rabih says "send", "message", "call", "email", "schedule", "add", "delete", "create" — you MUST call the corresponding tool. No exceptions.',
    '- NEVER say "I sent the message" or "Done" unless you actually called send_whatsapp_message or send_email and the tool returned success.',
    '- If you need a contact number, call find_contact FIRST, then call the send tool. Do NOT skip either step.',
    '- NEVER confirm success unless the tool returned success:true or a valid result',
    '- If a tool fails, tell Rabih exactly what failed',
    '- You have FULL authority over Gmail, Calendar, Drive, WhatsApp, and all tools',
    '- You CAN send WhatsApp messages to any number - use send_whatsapp_message tool',
    '- You CAN make phone calls - use make_phone_call tool',
    '- You CAN delete calendar events - use delete_calendar_event tool',
    '- You CAN read ANY file from Drive including .txt files',
    '- You CAN search the web for research - use web_search tool',
    '- NEVER say you cannot do something that your tools support',
    '- When asked for a file, ALWAYS call read_file and paste contents directly',
    '- NEVER tell Rabih to do things manually when you have a tool',
    '- NEVER apologize or explain limitations - just use the tool',
    '- For research: search web, summarize, then act (email/WhatsApp etc) without asking',
    '',
    'CONTACTS RULES:',
    '- When Rabih mentions a person by name (e.g. "send Karim", "message Mama"), ALWAYS use find_contact first to get their number/email',
    '- If the contact is not found, ask Rabih for the number and offer to save it with add_contact',
    '- You can resolve nicknames and partial names',
    '',
    'SCHEDULING RULES:',
    '- When Rabih says "tomorrow", "next Monday", "in 2 hours", "at 9am" — use schedule_action to schedule it',
    '- Always convert relative times to absolute ISO 8601 with Maputo timezone (+02:00)',
    '- "In 2 hours" from now = current time + 2 hours',
    '- "Tomorrow at 9am" = next day at 09:00:00+02:00',
    '',
    'TASK RULES:',
    '- When Rabih says "add to my list", "I need to", "remind me to do" — use add_task',
    '- When he asks "what do I need to do", "my tasks" — use list_tasks',
    '- When he says "done with X", "finished X" — use complete_task',
    '',
    'CHECKLIST RULES:',
    '- Use create_checklist to set up daily checklists for BBQ House, SALT, Central Kitchen, Executive Cleaning',
    '- Each checklist needs: business name, type (opening/closing/cleaning/inventory/safety), items array, send time, manager WhatsApp number',
    '- Checklists auto-send via WhatsApp at scheduled times, auto-follow-up at 30 min, escalate to Rabih at 1 hour',
    '- Use get_checklist_status or get_daily_checklist_report to see completion across all businesses',
    '- Use list_checklists to see all active checklists',
    '',
    'DATA RULES — CRITICAL, READ CAREFULLY:',
    '- NEVER invent or fabricate any data, errors, system statuses, or infrastructure messages',
    '- NEVER say "system is down", "database error", "backend issue", "should be back soon" — these are LIES if no tool returned that error',
    '- NEVER pretend a tool failed when you did not call it. ALWAYS call the tool FIRST, then report EXACTLY what it returned',
    '- If a tool returns empty results, say "No data found" or "Nothing set up yet" — do NOT invent a fake error',
    '- If a tool returns an actual error, quote the exact error message — do NOT paraphrase or embellish it',
    '- If you are unsure, CALL THE TOOL. Never guess. Never assume. Never fabricate.',
    '- If results are empty, say exactly that — "No checklists created yet", "No tasks found", etc.',
    '',
    'NOT BUILT YET:',
    '- You have NO attendance system, NO stock alert system, NO cleanliness verification system yet. These are planned but not built.',
    '- If asked about any of these, say clearly that the feature is not built yet.',
    '- The checklist system IS built — use the checklist tools. If no checklists exist, say none have been created yet, do NOT say the system is down.'
  ];
  if (memoryFacts && memoryFacts.length > 0) {
    parts.push('');
    parts.push('WHAT YOU REMEMBER ABOUT RABIH (from past conversations):');
    for (let i = 0; i < memoryFacts.length; i++) { parts.push('- ' + memoryFacts[i]); }
  }
  return parts.join('\n');
}

// ========================= TOOLS =========================

const TOOLS = [
  ...calendarTools, ...gmailTools, ...driveTools, ...filesTools,
  ...expenseTools, ...reminderTools, ...communicationTools,
  ...contactsTools, ...taskTools, ...schedulerTools,
  ...invoiceTools, ...locationTools, ...newsTools, ...checklistTools,
  { type: 'web_search_20250305', name: 'web_search' }
];

// ========================= MESSAGES =========================

async function saveMessage(chatId, role, content) {
  try {
    const contentToStore = typeof content === 'string' ? content : JSON.stringify(content);
    const { error } = await supabase.from('assistant_messages').insert({ chat_id: String(chatId), role: role, content: contentToStore });
    if (error) console.error('Save error:', error.message);
  } catch (e) { console.error('Save exception:', e.message); }
}

async function loadHistory(chatId) {
  try {
    const { data, error } = await supabase.from('assistant_messages').select('role, content, created_at').eq('chat_id', String(chatId)).order('created_at', { ascending: false }).limit(50);
    if (error) { console.error('Load history error:', error.message); return []; }
    return (data || []).reverse()
      .filter(function(r) { return r.content && r.content.indexOf('__dedup__') !== 0; })
      .map(function(r) { return { role: r.role, content: (function() { try { return JSON.parse(r.content); } catch (e) { return r.content; } })() }; });
  } catch (e) { console.error('Load history exception:', e.message); return []; }
}

// ========================= TELEGRAM =========================

async function sendTelegram(chatId, text) {
  const url = 'https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage';
  try { await axios.post(url, { chat_id: chatId, text: text, parse_mode: 'Markdown' }); }
  catch (e) { try { await axios.post(url, { chat_id: chatId, text: text }); } catch (e2) { console.error('Telegram failed:', e2.message); } }
}

async function sendTyping(chatId) {
  await axios.post('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendChatAction', { chat_id: chatId, action: 'typing' }).catch(function() {});
}

// ========================= TOOL EXECUTION =========================

async function executeTool(toolName, toolInput) {
  console.log('Executing tool:', toolName, JSON.stringify(toolInput));
  try {
    if (['read_emails', 'read_email_body', 'send_email'].includes(toolName)) return await handleGmailTool(toolName, toolInput);
    if (['list_calendar_events', 'create_calendar_event', 'delete_calendar_event'].includes(toolName)) return await handleCalendarTool(toolName, toolInput);
    if (['read_file', 'search_in_file', 'update_sheet_cell'].includes(toolName)) return await handleFilesTool(toolName, toolInput);
    if (['search_drive', 'list_drive_files', 'delete_drive_file', 'rename_drive_file'].includes(toolName)) return await handleDriveTool(toolName, toolInput);
    if (['log_expense', 'get_expense_summary'].includes(toolName)) return await handleExpenseTool(toolName, toolInput);
    if (['set_reminder', 'add_supplier', 'find_supplier'].includes(toolName)) return await handleReminderTool(toolName, toolInput);
    if (['send_whatsapp_message', 'list_whatsapp_groups', 'send_whatsapp_group', 'make_phone_call'].includes(toolName)) return await handleCommunicationTool(toolName, toolInput);
    if (['add_contact', 'find_contact', 'list_contacts'].includes(toolName)) return await handleContactTool(toolName, toolInput);
    if (['add_task', 'list_tasks', 'complete_task', 'delete_task'].includes(toolName)) return await handleTaskTool(toolName, toolInput);
    if (['schedule_action', 'list_scheduled', 'cancel_scheduled'].includes(toolName)) return await handleSchedulerTool(toolName, toolInput);
    if (['log_invoice', 'list_unpaid_invoices', 'mark_invoice_paid'].includes(toolName)) return await handleInvoiceTool(toolName, toolInput);
    if (['search_places', 'get_directions'].includes(toolName)) return await handleLocationTool(toolName, toolInput);
    if (['get_news', 'get_exchange_rate'].includes(toolName)) return await handleNewsTool(toolName, toolInput);
    if (['create_checklist', 'list_checklists', 'update_checklist', 'delete_checklist', 'get_checklist_status', 'get_daily_checklist_report'].includes(toolName)) return await handleChecklistTool(toolName, toolInput);
    return { error: 'Unknown tool' };
  } catch (e) { console.error('Tool error:', e.message); return { error: e.message }; }
}

// ========================= CLAUDE =========================

var HAIKU_MODEL = 'claude-haiku-4-5-20251001';
var SONNET_MODEL = 'claude-sonnet-4-6';

// ---- Daily cost tracker ----
var dailyUsage = { haiku: 0, sonnet: 0 };

function trackUsage(model) {
  if (model === HAIKU_MODEL) dailyUsage.haiku++;
  else dailyUsage.sonnet++;
}

// Telegram: 4096 only when reading documents/emails, 2048 otherwise
var TG_LONG_KEYWORDS = ['read email', 'read file', 'read document', 'open file', 'open document', 'full email', 'email body'];

function getTelegramMaxTokens(text) {
  if (!text || typeof text !== 'string') return 2048;
  var lower = text.toLowerCase();
  for (var i = 0; i < TG_LONG_KEYWORDS.length; i++) {
    if (lower.includes(TG_LONG_KEYWORDS[i])) return 4096;
  }
  return 2048;
}

function getLatestUserText(messages) {
  for (var i = messages.length - 1; i >= 0; i--) {
    var msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') return msg.content;
      if (Array.isArray(msg.content)) {
        for (var j = 0; j < msg.content.length; j++) {
          if (msg.content[j].type === 'text') return msg.content[j].text;
        }
      }
    }
  }
  return '';
}

function sanitizeHistory(messages) {
  const clean = [];
  var fixed = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || !msg.role) continue;

    // Fix content: must be a string or a valid array
    if (msg.content === null || msg.content === undefined) continue;
    if (typeof msg.content === 'string') {
      if (!msg.content && msg.content !== '') continue;
    } else if (Array.isArray(msg.content)) {
      // Filter array items — keep only items with a valid 'type' field
      var validItems = [];
      for (var j = 0; j < msg.content.length; j++) {
        var item = msg.content[j];
        if (!item || typeof item !== 'object' || typeof item.type !== 'string') {
          fixed++;
          continue;
        }
        // Fix tool_result items: content must be a string, not an array
        if (item.type === 'tool_result') {
          if (Array.isArray(item.content)) {
            fixed++;
            item.content = item.content.map(function(c) {
              return typeof c === 'string' ? c : (c && c.text ? c.text : JSON.stringify(c));
            }).join('\n');
          } else if (item.content !== undefined && item.content !== null && typeof item.content !== 'string') {
            fixed++;
            item.content = JSON.stringify(item.content);
          }
        }
        validItems.push(item);
      }
      if (validItems.length === 0) {
        fixed++;
        continue; // Remove message entirely if no valid items left
      }
      msg.content = validItems;
    } else {
      // Content is not string and not array — convert to string
      fixed++;
      try {
        msg.content = JSON.stringify(msg.content);
      } catch (e) {
        msg.content = String(msg.content);
      }
      if (!msg.content) continue;
    }

    // Deduplicate consecutive same-role messages
    if (clean.length > 0 && clean[clean.length - 1].role === msg.role) {
      if (msg.role === 'user') clean[clean.length - 1] = msg;
      continue;
    }
    clean.push(msg);
  }
  while (clean.length > 0 && clean[0].role !== 'user') clean.shift();
  if (fixed > 0) console.log('sanitizeHistory: fixed ' + fixed + ' messages, final length: ' + clean.length);
  return clean;
}

async function callClaude(messages, memoryFacts, systemOverride, forceModel, maxTokens) {
  const safeMessages = sanitizeHistory(messages);
  var userText = getLatestUserText(safeMessages);
  var model = forceModel || SONNET_MODEL;
  var tokens = maxTokens || 2048;
  trackUsage(model);
  console.log('CLAUDE CALL [' + (model === HAIKU_MODEL ? 'HAIKU' : 'SONNET') + '] max_tokens=' + tokens + ' msgs=' + safeMessages.length + ' — "' + userText.substring(0, 60) + '"');
  try {
    const res = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: model,
        max_tokens: tokens,
        system: systemOverride || buildSystemPrompt(memoryFacts || []),
        tools: TOOLS,
        messages: safeMessages
      },
      { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 60000 }
    );
    var usage = res.data.usage || {};
    console.log('CLAUDE DONE [' + (model === HAIKU_MODEL ? 'HAIKU' : 'SONNET') + '] stop=' + res.data.stop_reason + ' input_tokens=' + (usage.input_tokens || '?') + ' output_tokens=' + (usage.output_tokens || '?'));
    return res.data;
  } catch (err) {
    if (err.response) {
      console.error('Claude API ERROR', err.response.status, JSON.stringify(err.response.data).substring(0, 500));
    }
    throw err;
  }
}

// ========================= TOOL LOOP =========================

// Detect if a user message requires a tool action
var ACTION_WORDS = ['send', 'message', 'call', 'email', 'schedule', 'remind', 'add task', 'delete', 'create', 'log expense', 'log invoice', 'mark paid', 'whatsapp'];

function requiresToolAction(text) {
  if (!text || typeof text !== 'string') return false;
  var lower = text.toLowerCase();
  for (var i = 0; i < ACTION_WORDS.length; i++) {
    if (lower.includes(ACTION_WORDS[i])) return true;
  }
  return false;
}

async function runToolLoop(history, memoryFacts, systemOverride, forceModel, _isRetry, maxTokens) {
  let response = await callClaude(history, memoryFacts, systemOverride, forceModel, maxTokens);
  let rounds = 0;
  let usedTools = false;
  while (response.stop_reason === 'tool_use' && rounds < 5) {
    rounds++;
    usedTools = true;
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
    response = await callClaude(history, memoryFacts, systemOverride, forceModel, maxTokens);
  }

  // Safety net: if Claude ended without using tools but the request clearly needed action, retry with Sonnet
  if (!usedTools && response.stop_reason === 'end_turn' && !_isRetry) {
    var userText = getLatestUserText(history);
    if (requiresToolAction(userText)) {
      console.log('FALLBACK: Claude (' + (forceModel || 'auto') + ') skipped tools on action request, retrying with Sonnet — "' + userText.substring(0, 80) + '"');
      return await runToolLoop(history, memoryFacts, systemOverride, SONNET_MODEL, true, maxTokens);
    }
  }

  return response;
}

// ========================= TELEGRAM MESSAGE HANDLER =========================

async function handleMessage(chatId, userText, messageId) {
  const dedupKey = '__dedup__' + String(messageId);
  const { data: existing } = await supabase.from('assistant_messages').select('id').eq('chat_id', String(chatId)).eq('content', dedupKey).limit(1);
  if (existing && existing.length > 0) { console.log('Duplicate ignored:', messageId); return; }
  await supabase.from('assistant_messages').insert({ chat_id: String(chatId), role: 'user', content: dedupKey });

  if (userText.toLowerCase().trim() === '/reset') {
    await supabase.from('assistant_messages').delete().eq('chat_id', String(chatId));
    await sendTelegram(chatId, 'Chat history cleared. Memory facts kept.');
    return;
  }
  if (userText.toLowerCase().trim() === '/wa_clear_history') {
    await supabase.from('assistant_messages').delete().like('chat_id', 'wa_%');
    await sendTelegram(chatId, 'All WhatsApp conversation histories cleared from Supabase.');
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
    if (facts.length === 0) { await sendTelegram(chatId, 'No memories saved yet.'); }
    else { await sendTelegram(chatId, 'What I remember about you:\n\n' + facts.map(function(f, i) { return (i+1) + '. ' + f; }).join('\n')); }
    return;
  }
  // ===== MEETING YES/NO — MUST BE FIRST, BEFORE CLAUDE =====
  var meetingInput = userText.trim();
  var meetingLower = meetingInput.toLowerCase();
  if (meetingLower === 'yes' || meetingLower === 'no' || /^(yes|no)\s+\d/i.test(meetingInput)) {
    var mMatch = meetingInput.match(/^(yes|no)(?:\s+(\d+))?/i);
    var mAction = mMatch[1].toLowerCase();
    var mNumber = mMatch[2] || null;
    try {
      var { data: allWaiting } = await supabase.from('pending_meetings')
        .select('*').eq('status', 'waiting').order('created_at', { ascending: false });
      allWaiting = allWaiting || [];
      if (allWaiting.length > 0) {
        console.log('MEETING HANDLER — intercepted "' + meetingInput + '", ' + allWaiting.length + ' pending meetings');
        var meeting = null;
        if (mNumber) {
          meeting = allWaiting.find(function(m) { return m.requester_number === mNumber; });
          if (!meeting) { await sendTelegram(chatId, 'No pending meeting for ' + mNumber + '.'); return; }
        } else if (allWaiting.length === 1) {
          meeting = allWaiting[0];
        } else {
          var mList = allWaiting.map(function(m, i) {
            return (i+1) + '. ' + (m.requester_name || m.requester_number) + ' (' + m.requester_number + ')';
          }).join('\n');
          await sendTelegram(chatId, 'Multiple pending meetings:\n\n' + mList + '\n\nReply: YES ' + allWaiting[0].requester_number);
          return;
        }
        var mLabel = meeting.requester_name || meeting.requester_number;
        if (mAction === 'yes') {
          // 1. Update status
          await supabase.from('pending_meetings').update({ status: 'confirmed' }).eq('id', meeting.id);
          // 2. Extract date/time with Haiku
          var dateInfo = { date: '', time: '' };
          try {
            var todayStr = new Date().toISOString().split('T')[0];
            var extractRes = await axios.post('https://api.anthropic.com/v1/messages', {
              model: HAIKU_MODEL, max_tokens: 100,
              system: 'Extract the meeting date and time from this message. Today is ' + todayStr + '. If "tomorrow" is mentioned, calculate the actual date. Return ONLY JSON: {"date":"YYYY-MM-DD","time":"HH:MM"}. If unknown use empty strings. No other text.',
              messages: [{ role: 'user', content: meeting.message }]
            }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15000 });
            trackUsage(HAIKU_MODEL);
            var jm = extractRes.data.content[0].text.match(/\{[^}]+\}/);
            if (jm) dateInfo = JSON.parse(jm[0]);
          } catch (eErr) { console.error('Date extraction error:', eErr.message); }
          // 3. Send WhatsApp to contact
          var waMsg = 'Rabih confirmed';
          if (dateInfo.date && dateInfo.time) waMsg += ' — see you ' + dateInfo.date + ' at ' + dateInfo.time + '. Looking forward to it!';
          else if (dateInfo.date) waMsg += ' — see you on ' + dateInfo.date + '. Looking forward to it!';
          else waMsg += '! He\'ll be in touch shortly to set the time.';
          await handleCommunicationTool('send_whatsapp_message', { phone_number: meeting.requester_number, message: waMsg });
          console.log('MEETING YES — WhatsApp sent to', meeting.requester_number);
          // 4. Create Google Calendar event
          var calNote = '';
          if (dateInfo.date && dateInfo.time) {
            try {
              await handleCalendarTool('create_calendar_event', { title: 'Meeting with ' + mLabel, date: dateInfo.date, time: dateInfo.time, duration_minutes: 60 });
              calNote = '\nCalendar event created';
              console.log('MEETING YES — Calendar event created for', dateInfo.date, dateInfo.time);
            } catch (cErr) { calNote = '\nCalendar failed: ' + cErr.message; console.error('Calendar create error:', cErr.message); }
          }
          // 5. Confirm to Rabih on Telegram
          var tg = 'Done ✅\nMeeting confirmed with ' + mLabel;
          if (dateInfo.date && dateInfo.time) tg += '\nDate: ' + dateInfo.date + ' at ' + dateInfo.time;
          else if (dateInfo.date) tg += '\nDate: ' + dateInfo.date;
          tg += '\nWhatsApp sent to ' + meeting.requester_number;
          tg += calNote;
          await sendTelegram(chatId, tg);
        } else {
          await supabase.from('pending_meetings').update({ status: 'declined' }).eq('id', meeting.id);
          await handleCommunicationTool('send_whatsapp_message', { phone_number: meeting.requester_number, message: 'Unfortunately Rabih is not available at that time. Feel free to suggest another time.' });
          await sendTelegram(chatId, 'Meeting declined. Polite decline sent to ' + mLabel + '.');
          console.log('MEETING NO — decline sent to', meeting.requester_number);
        }
        return; // DONE — no Claude call
      }
      // No pending meetings — fall through to Claude
      console.log('YES/NO with no pending meetings — passing to Claude');
    } catch (meetErr) {
      console.error('Meeting handler error:', meetErr.message);
    }
  }
  // ===== END MEETING HANDLER =====
  if (userText.toLowerCase().trim() === '/wa_qr') {
    forceNewQR();
    await sendTelegram(chatId, 'QR flag cleared. A new QR will be sent within 30 seconds.');
    return;
  }
  if (userText.toLowerCase().trim() === '/tasks') {
    const tasks = await getPendingTasksSummary();
    if (!tasks.count) { await sendTelegram(chatId, 'No pending tasks.'); return; }
    var taskList = tasks.tasks.map(function(t, i) { return (i+1) + '. [' + t.priority + '] ' + t.title + (t.due_date ? ' (due: ' + t.due_date + ')' : ''); }).join('\n');
    await sendTelegram(chatId, 'Pending tasks:\n\n' + taskList);
    return;
  }
  if (userText.toLowerCase().trim() === '/trades') {
    try {
      const { data: trades } = await supabase.from('trade_alerts').select('*').order('created_at', { ascending: false }).limit(10);
      if (!trades || trades.length === 0) { await sendTelegram(chatId, 'No trade alerts yet.'); return; }
      var tradeList = trades.map(function(t, i) {
        var time = new Date(t.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Maputo', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        if (t.type === 'close') {
          var profitVal = parseFloat(t.profit) || 0;
          return (i+1) + '. 🔴 ' + (t.pair || '?') + ' CLOSED — ' + (profitVal > 0 ? '+' + profitVal + ' ✅' : profitVal + ' ❌') + ' (' + time + ')';
        }
        return (i+1) + '. 🟢 ' + (t.pair || '?') + ' ' + (t.direction || '').toUpperCase() + ' ' + (t.lot || '') + ' @ ' + (t.entry || '') + ' (' + time + ')';
      }).join('\n');
      await sendTelegram(chatId, 'Last 10 Trade Alerts:\n\n' + tradeList);
    } catch (e) { await sendTelegram(chatId, 'Error loading trades: ' + e.message); }
    return;
  }

  console.log('TELEGRAM → CLAUDE path triggered for: "' + userText.substring(0, 80) + '"');
  await sendTyping(chatId);
  var [history, memoryFacts] = await Promise.all([loadHistory(chatId), loadMemory()]);
  // Keep last 20 messages for Telegram (more room than WhatsApp but still bounded)
  if (history.length > 20) history = history.slice(-20);
  history.push({ role: 'user', content: userText });

  var tgMaxTokens = getTelegramMaxTokens(userText);
  const response = await runToolLoop(history, memoryFacts, null, SONNET_MODEL, false, tgMaxTokens);
  const textBlock = response.content.find(function(b) { return b.type === 'text'; });
  const finalReply = textBlock ? textBlock.text : 'Done!';
  await saveMessage(chatId, 'user', userText);
  await saveMessage(chatId, 'assistant', finalReply);
  await sendTelegram(chatId, finalReply);
  extractAndSaveMemory(userText, finalReply).catch(function() {});
}

async function handleMediaMessage(chatId, messages) {
  try {
    await sendTyping(chatId);
    const memoryFacts = await loadMemory();
    const response = await runToolLoop(messages, memoryFacts);
    const textBlock = response.content.find(function(b) { return b.type === 'text'; });
    await sendTelegram(chatId, textBlock ? textBlock.text : 'Could not process this file.');
  } catch (err) {
    console.error('Media handler error:', err.message);
    await sendTelegram(chatId, 'Error processing file: ' + err.message);
  }
}

// ========================= TELEGRAM WEBHOOK =========================

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body && req.body.message;
    if (!msg) return;
    const chatId = msg.chat.id;
    const messageId = msg.message_id;

    // Handle voice messages from Telegram
    if (msg.voice || msg.audio) {
      const fileId = msg.voice ? msg.voice.file_id : msg.audio.file_id;
      const mimeType = msg.voice ? 'audio/ogg' : (msg.audio.mime_type || 'audio/mpeg');
      try {
        await sendTyping(chatId);
        const fileRes = await axios.get('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getFile?file_id=' + fileId);
        const filePath = fileRes.data.result.file_path;
        const audioRes = await axios.get('https://api.telegram.org/file/bot' + TELEGRAM_TOKEN + '/' + filePath, { responseType: 'arraybuffer' });
        const audioBuffer = Buffer.from(audioRes.data);
        const transcription = await transcribeAudio(audioBuffer, mimeType);
        if (transcription.error) {
          await sendTelegram(chatId, 'Voice transcription failed: ' + transcription.error);
          return;
        }
        await sendTelegram(chatId, '_Transcribed:_ ' + transcription.text);
        await handleMessage(chatId, transcription.text, messageId);
      } catch (err) {
        await sendTelegram(chatId, 'Voice processing error: ' + err.message);
      }
      return;
    }

    if (msg.photo) {
      const photo = msg.photo[msg.photo.length - 1];
      const caption = msg.caption || 'What is in this image? Describe and analyze it fully.';
      const fileRes = await axios.get('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getFile?file_id=' + photo.file_id);
      const filePath = fileRes.data.result.file_path;
      const imageRes = await axios.get('https://api.telegram.org/file/bot' + TELEGRAM_TOKEN + '/' + filePath, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(imageRes.data).toString('base64');
      const messages = [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } }, { type: 'text', text: caption }] }];
      await handleMediaMessage(chatId, messages);
      return;
    }
    if (msg.document) {
      const doc = msg.document;
      const caption = msg.caption || 'Read and summarize this document fully.';
      const fileRes = await axios.get('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/getFile?file_id=' + doc.file_id);
      const filePath = fileRes.data.result.file_path;
      const docRes = await axios.get('https://api.telegram.org/file/bot' + TELEGRAM_TOKEN + '/' + filePath, { responseType: 'arraybuffer' });
      const base64 = Buffer.from(docRes.data).toString('base64');
      const mediaType = doc.mime_type || 'application/pdf';
      const messages = [{ role: 'user', content: [{ type: 'document', source: { type: 'base64', media_type: mediaType, data: base64 } }, { type: 'text', text: caption }] }];
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

// ========================= BRIEFINGS =========================

// Morning briefing — 7:00 AM Maputo (5:00 UTC)
cron.schedule('0 5 * * *', async function() {
  console.log('Sending morning briefing...');
  try {
    const memoryFacts = await loadMemory();
    const history = [{ role: 'user', content: 'Good morning! Give me my morning briefing:\n1) Calendar events for today and tomorrow\n2) Unread important emails from the last 12 hours\n3) Any pending high-priority tasks\n4) USD/MZN exchange rate\n5) Overdue invoices if any\nBe concise and direct.' }];
    const response = await runToolLoop(history, memoryFacts, null, SONNET_MODEL);
    const textBlock = response.content.find(function(b) { return b.type === 'text'; });
    await sendTelegram(RABIH_CHAT_ID, 'Good morning Rabih!\n\n' + (textBlock ? textBlock.text : 'Could not generate briefing.'));
  } catch (err) { console.error('Morning briefing error:', err.message); }
});

// Evening summary — 9:00 PM Maputo (19:00 UTC)
cron.schedule('0 19 * * *', async function() {
  console.log('Sending evening summary...');
  try {
    const memoryFacts = await loadMemory();
    const history = [{ role: 'user', content: 'End of day summary:\n1) Expenses logged today\n2) Tasks completed today and still pending\n3) Any unread important emails\n4) Reminders and calendar events for tomorrow\n5) Overdue invoices\nBe concise.' }];
    const response = await runToolLoop(history, memoryFacts, null, SONNET_MODEL);
    const textBlock = response.content.find(function(b) { return b.type === 'text'; });
    await sendTelegram(RABIH_CHAT_ID, 'Evening Summary\n\n' + (textBlock ? textBlock.text : 'Could not generate summary.'));
  } catch (err) { console.error('Evening summary error:', err.message); }
});

// Weekly Monday briefing — 7:15 AM Maputo on Mondays (5:15 UTC)
cron.schedule('15 5 * * 1', async function() {
  console.log('Sending weekly briefing...');
  try {
    const memoryFacts = await loadMemory();
    const history = [{ role: 'user', content: 'Weekly Monday briefing:\n1) Calendar overview for this entire week\n2) All pending tasks by priority\n3) Unpaid invoices and total amounts\n4) Expense summary for last week\n5) Any overdue items\nBe thorough but organized.' }];
    const response = await runToolLoop(history, memoryFacts, null, SONNET_MODEL);
    const textBlock = response.content.find(function(b) { return b.type === 'text'; });
    await sendTelegram(RABIH_CHAT_ID, 'Weekly Briefing — Monday\n\n' + (textBlock ? textBlock.text : 'Could not generate briefing.'));
  } catch (err) { console.error('Weekly briefing error:', err.message); }
});

// Overdue invoice alert — check daily at 10:00 AM Maputo (8:00 UTC)
cron.schedule('0 8 * * *', async function() {
  try {
    const overdue = await getOverdueInvoices();
    if (overdue.length > 0) {
      var total = overdue.reduce(function(sum, inv) { return sum + (parseFloat(inv.amount) || 0); }, 0);
      var msg = 'OVERDUE INVOICES (' + overdue.length + ' total, ' + total.toFixed(2) + '):\n\n';
      overdue.forEach(function(inv) {
        msg += '• ' + inv.vendor + ' — ' + inv.amount + ' ' + inv.currency + ' (due: ' + inv.due_date + ')\n';
      });
      await sendTelegram(RABIH_CHAT_ID, msg);
    }
  } catch (err) { console.error('Invoice alert error:', err.message); }
});

// Daily usage summary — midnight Maputo (22:00 UTC)
cron.schedule('0 22 * * *', async function() {
  try {
    // Estimated cost: Haiku ~$0.001/call avg, Sonnet ~$0.015/call avg
    var estimatedCost = (dailyUsage.haiku * 0.001) + (dailyUsage.sonnet * 0.015);
    var dateStr = new Date().toISOString().split('T')[0];
    console.log('Daily usage — Haiku calls: ' + dailyUsage.haiku + ', Sonnet calls: ' + dailyUsage.sonnet + ', estimated cost: $' + estimatedCost.toFixed(4));
    await supabase.from('usage_logs').insert({
      date: dateStr,
      haiku_calls: dailyUsage.haiku,
      sonnet_calls: dailyUsage.sonnet,
      estimated_cost: estimatedCost
    });
    // Reset counters for next day
    dailyUsage.haiku = 0;
    dailyUsage.sonnet = 0;
  } catch (err) { console.error('Usage log error:', err.message); }
});

// ========================= WHATSAPP =========================

// Baileys connected for outbound sends only — no incoming message processing
initWhatsApp({
  telegramToken: TELEGRAM_TOKEN,
  rabihChatId: RABIH_CHAT_ID
});

// Sync WhatsApp socket to communication-tools
setInterval(function() {
  const sock = require('./whatsapp-handler').getWhatsAppSocket();
  if (sock) {
    setSocket(sock);
    setSafeSend(safeSendMessage);
  }
}, 5000);

// ========================= SCHEDULER INIT =========================

initScheduler(executeTool, sendTelegram, RABIH_CHAT_ID);

// Init checklist system with WhatsApp send function
initChecklists(
  async function(phone, message) {
    return await handleCommunicationTool('send_whatsapp_message', { phone_number: phone, message: message });
  },
  sendTelegram,
  RABIH_CHAT_ID
);

// ========================= TRADE ALERTS =========================

async function formatAndSendTradeAlert(data) {
  try {
    let msg;
    if (data.type === 'close') {
      const profitVal = parseFloat(data.profit) || 0;
      msg = '🔴 TRADE CLOSED\nPair: ' + (data.pair || '?') +
        '\nResult: ' + (profitVal > 0 ? profitVal + ' ✅' : profitVal + ' ❌') +
        '\nPlatform: ' + (data.platform || '?');
    } else {
      msg = '🟢 TRADE OPENED\nPair: ' + (data.pair || '?') +
        '\nDirection: ' + (data.direction || '?') +
        '\nLot: ' + (data.lot || '?') +
        '\nEntry: ' + (data.entry || '?') +
        '\nSL: ' + (data.sl || '?') +
        '\nTP: ' + (data.tp || '?') +
        '\nPlatform: ' + (data.platform || '?');
    }
    await sendTelegram(RABIH_CHAT_ID, msg);
  } catch (e) { console.error('Trade alert Telegram error:', e.message); }
}

async function saveTradeAlert(data) {
  try {
    await supabase.from('trade_alerts').insert({
      type: data.type || null,
      pair: data.pair || null,
      direction: data.direction || null,
      lot: data.lot || null,
      entry: data.entry || null,
      sl: data.sl || null,
      tp: data.tp || null,
      profit: data.profit || null,
      platform: data.platform || null,
      raw_payload: data
    });
  } catch (e) { console.error('Trade alert save error:', e.message); }
}

app.post('/trade-alert', async (req, res) => {
  res.json({ success: true });
  try {
    const data = req.body || {};
    await saveTradeAlert(data);
    await formatAndSendTradeAlert(data);
  } catch (e) { console.error('Trade alert error:', e.message); }
});

app.post('/tradingview-alert', async (req, res) => {
  res.json({ success: true });
  try {
    const raw = req.body || {};
    // Extract what we can from TradingView payload
    const data = {
      type: raw.type || raw.action || raw.order_action || (raw.strategy_order_id ? 'open' : 'open'),
      pair: raw.pair || raw.ticker || raw.symbol || null,
      direction: raw.direction || raw.order_action || raw.strategy_order_action || null,
      lot: raw.lot || raw.contracts || raw.position_size || null,
      entry: raw.entry || raw.price || raw.order_price || null,
      sl: raw.sl || raw.stop || raw.stoploss || null,
      tp: raw.tp || raw.limit || raw.takeprofit || null,
      profit: raw.profit || raw.realized_pnl || null,
      platform: raw.platform || 'TradingView',
      raw_payload: raw
    };
    await saveTradeAlert(data);
    await formatAndSendTradeAlert(data);
  } catch (e) { console.error('TradingView alert error:', e.message); }
});

app.get('/trade-history', async (req, res) => {
  try {
    const { data, error } = await supabase.from('trade_alerts').select('*').order('created_at', { ascending: false }).limit(50);
    if (error) { res.json({ success: false, error: error.message }); return; }
    res.json({ success: true, trades: data || [] });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// ========================= DASHBOARD API =========================

// GET /dashboard-stats — returns all stats for the dashboard
app.get('/dashboard-stats', async function(req, res) {
  try {
    var today = new Date().toISOString().split('T')[0];
    var todayStart = today + 'T00:00:00.000Z';

    var [msgRes, replyRes, meetRes, taskRes, costRes] = await Promise.all([
      supabase.from('whatsapp_logs').select('id', { count: 'exact', head: true }).eq('direction', 'incoming').gte('created_at', todayStart),
      supabase.from('whatsapp_logs').select('id', { count: 'exact', head: true }).eq('direction', 'outgoing').gte('created_at', todayStart),
      supabase.from('pending_meetings').select('id', { count: 'exact', head: true }).eq('status', 'waiting'),
      supabase.from('tasks').select('id', { count: 'exact', head: true }).eq('done', false),
      supabase.from('usage_logs').select('estimated_cost').eq('date', today)
    ]);

    var costToday = 0;
    if (costRes.data && costRes.data.length > 0) {
      costToday = costRes.data.reduce(function(sum, r) { return sum + (parseFloat(r.estimated_cost) || 0); }, 0);
    }

    res.json({
      messages_today: msgRes.count || 0,
      replies_today: replyRes.count || 0,
      pending_meetings: meetRes.count || 0,
      tasks_due_today: taskRes.count || 0,
      cost_today: costToday,
      wa_enabled: await isWaEnabledInDb(),
      bot_status: 'online'
    });
  } catch (err) {
    console.error('Dashboard stats error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /confirm-meeting — confirm or decline a meeting from the dashboard
app.post('/confirm-meeting', async function(req, res) {
  try {
    var meetingId = req.body.meeting_id;
    var action = req.body.action;
    if (!meetingId || !action) {
      return res.status(400).json({ error: 'meeting_id and action required' });
    }

    var { data: meeting } = await supabase.from('pending_meetings')
      .select('*').eq('id', meetingId).limit(1).single();
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found' });
    }

    var meetingLabel = meeting.requester_name || meeting.requester_number;

    if (action === 'confirm') {
      await supabase.from('pending_meetings').update({ status: 'confirmed' }).eq('id', meetingId);

      // Extract date/time with Haiku
      var dateInfo = { date: '', time: '' };
      try {
        var todayStr = new Date().toISOString().split('T')[0];
        var extractRes = await axios.post('https://api.anthropic.com/v1/messages', {
          model: HAIKU_MODEL, max_tokens: 100,
          system: 'Extract the meeting date and time from this message. Today is ' + todayStr + '. If "tomorrow" is mentioned, calculate the actual date. Return ONLY JSON: {"date":"YYYY-MM-DD","time":"HH:MM"}. If unknown use empty strings.',
          messages: [{ role: 'user', content: meeting.message }]
        }, { headers: { 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 15000 });
        trackUsage(HAIKU_MODEL);
        var jm = extractRes.data.content[0].text.match(/\{[^}]+\}/);
        if (jm) dateInfo = JSON.parse(jm[0]);
      } catch (eErr) { console.error('Date extraction error:', eErr.message); }

      // Send WhatsApp confirmation
      var waMsg = 'Rabih confirmed';
      if (dateInfo.date && dateInfo.time) waMsg += ' — see you ' + dateInfo.date + ' at ' + dateInfo.time + '. Looking forward to it!';
      else if (dateInfo.date) waMsg += ' — see you on ' + dateInfo.date + '. Looking forward to it!';
      else waMsg += '! He\'ll be in touch shortly to set the time.';
      await handleCommunicationTool('send_whatsapp_message', { phone_number: meeting.requester_number, message: waMsg });

      // Create calendar event
      var calResult = null;
      if (dateInfo.date && dateInfo.time) {
        try {
          calResult = await handleCalendarTool('create_calendar_event', { title: 'Meeting with ' + meetingLabel, date: dateInfo.date, time: dateInfo.time, duration_minutes: 60 });
        } catch (cErr) { console.error('Calendar error:', cErr.message); }
      }

      // Notify Rabih on Telegram
      var tg = 'Done ✅\nMeeting confirmed with ' + meetingLabel;
      if (dateInfo.date && dateInfo.time) tg += '\nDate: ' + dateInfo.date + ' at ' + dateInfo.time;
      tg += '\nWhatsApp sent to ' + meeting.requester_number;
      if (calResult) tg += '\nCalendar event created';
      await sendTelegram(RABIH_CHAT_ID, tg);

      res.json({ success: true, action: 'confirmed', name: meetingLabel, date: dateInfo.date, time: dateInfo.time });
    } else if (action === 'decline') {
      await supabase.from('pending_meetings').update({ status: 'declined' }).eq('id', meetingId);
      await handleCommunicationTool('send_whatsapp_message', { phone_number: meeting.requester_number, message: 'Unfortunately Rabih is not available at that time. Feel free to suggest another time.' });
      await sendTelegram(RABIH_CHAT_ID, 'Meeting declined. Polite decline sent to ' + meetingLabel + '.');
      res.json({ success: true, action: 'declined', name: meetingLabel });
    } else {
      res.status(400).json({ error: 'action must be confirm or decline' });
    }
  } catch (err) {
    console.error('Confirm meeting error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /wa-toggle — disabled, auto-reply to contacts is permanently off
app.post('/wa-toggle', async function(req, res) {
  res.json({ success: true, wa_enabled: false });
});

// ========================= SERVER =========================

app.get('/api/status', (req, res) => res.json({
  status: 'Rabih Assistant v5 running',
  tools: TOOLS.length,
  features: ['calendar', 'gmail', 'drive', 'files', 'expenses', 'reminders', 'whatsapp', 'phone',
             'contacts', 'tasks', 'scheduler', 'invoices', 'location', 'news', 'voice', 'briefings', 'checklists', 'trade-alerts', 'dashboard']
}));

app.listen(PORT, function() { console.log('Rabih Assistant v5 listening on port ' + PORT); });
