const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_SERVICE_KEY;
const PORT           = process.env.PORT || 3000;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function buildSystemPrompt() {
  const now   = new Date();
  const today = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time  = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `You are the personal AI assistant of Rabih. You work for him full-time.
Today is ${today}, current time is ${time} (Maputo time, UTC+2).
About Rabih:
- Lebanese businessman based in Maputo, Mozambique
- Runs Rabih Group: BBQ House LDA, SALT LDA, Central Kitchen LDA, Executive Cleaning Services
- Also owns Burgerury burger brand in Beirut, Lebanon
- Speaks English and Arabic, sometimes mixes both
- Direct person, get things done, no unnecessary questions
Your personality:
- Real personal assistant, like a top-tier human EA
- Concise, direct, warm
- Remember everything from the conversation
- Reply in the same language Rabih uses
- Never say you are an AI unless directly asked`;
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

async function callClaude(messages) {
  console.log('Calling Claude with', messages.length, 'messages...');
  const res = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      system: buildSystemPrompt(),
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
  console.log('Claude responded OK');
  return res.data;
}

async function handleMessage(chatId, userText) {
  await sendTyping(chatId);
  const history = await loadHistory(chatId);
  console.log('History loaded:', history.length, 'messages');
  const messages = [...history, { role: 'user', content: userText }];
  const response = await callClaude(messages);
  const textBlock = response.content.find(b => b.type === 'text');
  const finalReply = textBlock?.text || 'Done!';
  await sendTelegram(chatId, finalReply);
  await saveMessages(chatId, userText, finalReply);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const msg = req.body?.message;
    if (!msg?.text) return;
    const chatId   = msg.chat.id;
    const userText = msg.text;
    console.log(`[${chatId}] ${userText}`);
    await handleMessage(chatId, userText);
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message || 'Unknown error';
    console.error('Handler error:', errMsg);
    console.error('Full error:', JSON.stringify(err.response?.data || err.message));
    try {
      const chatId = req.body?.message?.chat?.id;
      if (chatId) await sendTelegram(chatId, 'Error: ' + errMsg);
    } catch(e) {}
  }
});

app.get('/', (req, res) => res.json({ status: 'Rabih Assistant running' }));

app.listen(PORT, () => console.log(`Rabih Assistant listening on port ${PORT}`));
