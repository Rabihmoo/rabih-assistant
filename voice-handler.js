const axios = require('axios');
const FormData = require('form-data');

async function transcribeAudio(audioBuffer, mimeType) {
  var apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { error: 'GROQ_API_KEY not configured. Add it to Railway env vars for free voice transcription (get it from console.groq.com).' };

  try {
    var ext = 'ogg';
    if (mimeType && mimeType.includes('mp4')) ext = 'mp4';
    if (mimeType && mimeType.includes('mpeg')) ext = 'mp3';
    if (mimeType && mimeType.includes('wav')) ext = 'wav';
    if (mimeType && mimeType.includes('webm')) ext = 'webm';
    if (mimeType && mimeType.includes('opus')) ext = 'ogg';

    var form = new FormData();
    form.append('file', audioBuffer, { filename: 'audio.' + ext, contentType: mimeType || 'audio/ogg' });
    form.append('model', 'whisper-large-v3');
    form.append('response_format', 'json');

    var res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
      headers: Object.assign({}, form.getHeaders(), { 'Authorization': 'Bearer ' + apiKey }),
      timeout: 30000,
      maxContentLength: 25 * 1024 * 1024
    });

    var text = res.data.text;
    if (!text || !text.trim()) return { error: 'Could not transcribe audio — no speech detected.' };
    return { success: true, text: text.trim() };
  } catch (err) {
    var errMsg = (err.response && err.response.data && err.response.data.error && err.response.data.error.message) || err.message;
    console.error('Groq Whisper transcription error:', errMsg);
    return { error: 'Transcription failed: ' + errMsg };
  }
}

module.exports = { transcribeAudio: transcribeAudio };
