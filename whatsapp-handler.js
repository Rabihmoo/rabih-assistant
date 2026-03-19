initWhatsApp(TELEGRAM_TOKEN, RABIH_CHAT_ID, async function(text, source, from) {
  const history = await loadHistory('whatsapp_' + from);
  history.push({ role: 'user', content: text });
  let response = await callClaude(history);
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
    response = await callClaude(history);
  }
  const textBlock = response.content.find(function(b) { return b.type === 'text'; });
  const finalReply = textBlock ? textBlock.text : 'Done!';
  await saveMessage('whatsapp_' + from, 'user', text);
  await saveMessage('whatsapp_' + from, 'assistant', finalReply);
  return finalReply;
});
