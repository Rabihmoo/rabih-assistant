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
- Runs Rabih Group: BBQ House LDA, SALT LDA (restaurant/bar), Central Kitchen LDA, Executive Cleaning Services
- Also owns Burgerury burger brand in Beirut, Lebanon
- Speaks English and Arabic, sometimes mixes both
- Direct person — get things done, no unnecessary questions
Your personality:
- Real personal assistant, like a top-tier human EA
- Concise, direct, warm
- Remember everything from the conversation
- Reply in the same language Rabih uses (English or Arabic)
- Never say you are an AI unless directly asked`;
}

async function loadHistory(chatId) {
  const { data, error } = await supabase
    .from('assistant_messages')
    .select('role, content, created_at')
    .eq('chat_id', String(chatId))
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) { console.error('Load history error:', error); return []; }
  return (data || []).reverse().map(r => ({ role: r.role, content: r.content }));
}

async function saveMessages(chatId, userText, assistantReply) {
  const rows = [
    { chat_id: String(chatId), role: 'user',      content: userText },
    { chat_id: String(chatId), role: 'assistant', content: assistantReply }
  ];
  const { error } = await supabase.from('assistant_messages').insert(rows);
  if (error) console.error('Save messages error:', error);
}

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    await axios.post(url, { chat_id: chatId, text, parse_mode: 'Markdown' });
  } catch(e) {
    await axios.post(url, { chat_id: chatId, text }).catch(()=>{});
  }
}

async function sendTyping(chatId) {
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendChatAction`, {
    chat_id: chatId, action: 'typing'
  }).catch(() => {});
}

async function callClaude(messages) {
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
      }
    }
  );
  return res.data;
}

async function handleMessage(chatId, userText) {
  await sendTyping(chatId);
  const history = await loadHistory(chatId);
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
    console.error('Handler error:', err.response?.data || err.message);
  }
});

app.get('/', (req, res) => res.json({ status: 'Rabih Assistant running' }));

app.listen(PORT, () => console.log(`Rabih Assistant listening on port ${PORT}`));
