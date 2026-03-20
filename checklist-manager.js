const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

var _sendWhatsApp = null;
var _sendTelegram = null;
var _rabihChatId = null;

function initChecklists(sendWhatsApp, sendTelegram, rabihChatId) {
  _sendWhatsApp = sendWhatsApp;
  _sendTelegram = sendTelegram;
  _rabihChatId = rabihChatId;

  // Every minute — check if checklists need to be sent
  cron.schedule('* * * * *', function() {
    sendDueChecklists().catch(function(err) {
      console.error('Checklist send cron error:', err.message);
    });
  });

  // Every minute — check for follow-ups (30 min no response) and escalations (1 hour no response)
  cron.schedule('* * * * *', function() {
    checkFollowUpsAndEscalations().catch(function(err) {
      console.error('Checklist follow-up cron error:', err.message);
    });
  });

  // 10pm Maputo (20:00 UTC) — daily checklist summary
  cron.schedule('0 20 * * *', function() {
    sendDailyChecklistReport().catch(function(err) {
      console.error('Checklist daily report error:', err.message);
    });
  });

  console.log('Checklist system started — sending, follow-ups, and 10pm daily report');
}

// ========================= SEND DUE CHECKLISTS =========================

async function sendDueChecklists() {
  var now = new Date();
  var maputoHour = String((now.getUTCHours() + 2) % 24).padStart(2, '0');
  var maputoMin = String(now.getUTCMinutes()).padStart(2, '0');
  var currentTime = maputoHour + ':' + maputoMin;
  var today = now.toISOString().split('T')[0];
  var dayOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][now.getUTCDay()];

  // Find checklists that should be sent now
  var res = await supabase.from('checklists')
    .select('*')
    .eq('active', true)
    .eq('send_time', currentTime);

  if (res.error || !res.data || res.data.length === 0) return;

  for (var i = 0; i < res.data.length; i++) {
    var checklist = res.data[i];

    // Check if it's the right day (daily, or specific days)
    var frequency = checklist.frequency || 'daily';
    if (frequency !== 'daily') {
      var days = frequency.split(',').map(function(d) { return d.trim().toLowerCase(); });
      if (!days.includes(dayOfWeek)) continue;
    }

    // Check if already sent today
    var alreadySent = await supabase.from('checklist_sends')
      .select('id')
      .eq('checklist_id', checklist.id)
      .gte('sent_at', today + 'T00:00:00')
      .limit(1);

    if (alreadySent.data && alreadySent.data.length > 0) continue;

    // Build the checklist message
    var items = typeof checklist.items === 'string' ? JSON.parse(checklist.items) : checklist.items;
    var msg = '*' + checklist.business + ' — ' + checklist.type + '*\n\n';
    for (var j = 0; j < items.length; j++) {
      msg += (j + 1) + '. ' + items[j] + '\n';
    }
    msg += '\nPlease reply with status for each item. You can send a photo as proof.';
    msg += '\nExample: "1. Done ✅ 2. Issue — fridge temp high 3. Done ✅"';

    // Send to designated manager
    var managerNumber = checklist.manager_number;
    if (managerNumber && _sendWhatsApp) {
      var sendResult = await _sendWhatsApp(managerNumber, msg);
      console.log('Checklist sent to', managerNumber, ':', checklist.type, sendResult.success ? 'OK' : sendResult.error);

      // Record the send
      await supabase.from('checklist_sends').insert({
        checklist_id: checklist.id,
        manager_number: managerNumber,
        business: checklist.business,
        type: checklist.type,
        items: items,
        status: 'sent',
        sent_at: new Date().toISOString(),
        followup_sent: false,
        escalated: false
      });
    }
  }
}

// ========================= FOLLOW-UPS & ESCALATIONS =========================

async function checkFollowUpsAndEscalations() {
  var now = new Date();

  // Find sends that have no response
  var pending = await supabase.from('checklist_sends')
    .select('*')
    .eq('status', 'sent')
    .lt('sent_at', new Date(now.getTime() - 30 * 60 * 1000).toISOString());

  if (pending.error || !pending.data || pending.data.length === 0) return;

  for (var i = 0; i < pending.data.length; i++) {
    var send = pending.data[i];
    var sentTime = new Date(send.sent_at);
    var minutesAgo = (now.getTime() - sentTime.getTime()) / 60000;

    // 30 minutes — send follow-up
    if (minutesAgo >= 30 && !send.followup_sent) {
      if (_sendWhatsApp) {
        await _sendWhatsApp(send.manager_number,
          'Reminder: Please complete the *' + send.type + '* checklist for *' + send.business + '*. Waiting for your response.');
      }
      await supabase.from('checklist_sends').update({ followup_sent: true }).eq('id', send.id);
      console.log('Checklist follow-up sent to', send.manager_number, 'for', send.business);
    }

    // 60 minutes — escalate to Rabih
    if (minutesAgo >= 60 && !send.escalated) {
      if (_sendTelegram) {
        await _sendTelegram(_rabihChatId,
          '⚠️ CHECKLIST OVERDUE\n\n' +
          '*' + send.business + ' — ' + send.type + '*\n' +
          'Manager: ' + send.manager_number + '\n' +
          'Sent ' + Math.round(minutesAgo) + ' minutes ago — NO RESPONSE\n\n' +
          'Follow-up was already sent.');
      }
      await supabase.from('checklist_sends').update({ escalated: true }).eq('id', send.id);
      console.log('Checklist escalated to Rabih for', send.business, send.type);
    }
  }
}

// ========================= PROCESS RESPONSE =========================

async function processChecklistResponse(senderNumber, text, photoUrl) {
  // Find the most recent pending checklist for this manager
  var today = new Date().toISOString().split('T')[0];
  var pending = await supabase.from('checklist_sends')
    .select('*')
    .eq('manager_number', senderNumber.replace(/[^0-9]/g, ''))
    .eq('status', 'sent')
    .gte('sent_at', today + 'T00:00:00')
    .order('sent_at', { ascending: false })
    .limit(1);

  if (!pending.data || pending.data.length === 0) {
    // Try with the full number
    pending = await supabase.from('checklist_sends')
      .select('*')
      .ilike('manager_number', '%' + senderNumber.replace(/[^0-9]/g, '').slice(-9) + '%')
      .eq('status', 'sent')
      .gte('sent_at', today + 'T00:00:00')
      .order('sent_at', { ascending: false })
      .limit(1);
  }

  if (!pending.data || pending.data.length === 0) return false;

  var send = pending.data[0];

  // Save the response
  await supabase.from('checklist_responses').insert({
    checklist_id: send.checklist_id,
    send_id: send.id,
    responder_number: senderNumber,
    business: send.business,
    type: send.type,
    response: text,
    photo_url: photoUrl || null,
    status: 'received'
  });

  // Mark send as completed
  await supabase.from('checklist_sends').update({
    status: 'completed',
    completed_at: new Date().toISOString()
  }).eq('id', send.id);

  // Notify Rabih
  if (_sendTelegram) {
    var hasIssue = text.toLowerCase().includes('issue') || text.toLowerCase().includes('problem') ||
                   text.toLowerCase().includes('broken') || text.toLowerCase().includes('not working') ||
                   text.toLowerCase().includes('no') || text.toLowerCase().includes('fail');
    var icon = hasIssue ? '⚠️' : '✅';
    await _sendTelegram(_rabihChatId,
      icon + ' *' + send.business + ' — ' + send.type + '* completed\n\n' +
      'Manager: ' + senderNumber + '\n' +
      'Response: ' + text.substring(0, 500) +
      (photoUrl ? '\n📷 Photo attached' : ''));
  }

  console.log('Checklist response recorded for', send.business, send.type);
  return true;
}

// ========================= DAILY REPORT =========================

async function getDailyChecklistReport(date) {
  var targetDate = date || new Date().toISOString().split('T')[0];
  var nextDate = new Date(targetDate + 'T00:00:00');
  nextDate.setDate(nextDate.getDate() + 1);

  // Get all sends for the day
  var sends = await supabase.from('checklist_sends')
    .select('*')
    .gte('sent_at', targetDate + 'T00:00:00')
    .lt('sent_at', nextDate.toISOString().split('T')[0] + 'T00:00:00')
    .order('business');

  if (sends.error) return { error: sends.error.message };
  if (!sends.data || sends.data.length === 0) return { date: targetDate, message: 'No checklists were sent today.', businesses: {} };

  // Get all responses for the day
  var responses = await supabase.from('checklist_responses')
    .select('*')
    .gte('created_at', targetDate + 'T00:00:00')
    .lt('created_at', nextDate.toISOString().split('T')[0] + 'T00:00:00');

  var responseMap = {};
  (responses.data || []).forEach(function(r) {
    responseMap[r.send_id] = r;
  });

  // Group by business
  var businesses = {};
  sends.data.forEach(function(send) {
    if (!businesses[send.business]) businesses[send.business] = [];
    var resp = responseMap[send.id];
    businesses[send.business].push({
      type: send.type,
      manager: send.manager_number,
      status: send.status,
      sent_at: send.sent_at,
      completed_at: send.completed_at || null,
      response: resp ? resp.response.substring(0, 200) : null,
      has_photo: resp ? !!resp.photo_url : false,
      followup_sent: send.followup_sent,
      escalated: send.escalated
    });
  });

  var totalSent = sends.data.length;
  var totalCompleted = sends.data.filter(function(s) { return s.status === 'completed'; }).length;
  var totalOverdue = sends.data.filter(function(s) { return s.status === 'sent'; }).length;

  return {
    date: targetDate,
    total_sent: totalSent,
    total_completed: totalCompleted,
    total_overdue: totalOverdue,
    completion_rate: totalSent > 0 ? Math.round((totalCompleted / totalSent) * 100) + '%' : 'N/A',
    businesses: businesses
  };
}

async function sendDailyChecklistReport() {
  try {
    var report = await getDailyChecklistReport();
    if (report.message) {
      await _sendTelegram(_rabihChatId, '📋 Checklist Report: ' + report.message);
      return;
    }

    var msg = '📋 *DAILY CHECKLIST REPORT*\n';
    msg += 'Date: ' + report.date + '\n';
    msg += 'Completion: ' + report.total_completed + '/' + report.total_sent + ' (' + report.completion_rate + ')\n\n';

    var businessNames = Object.keys(report.businesses);
    for (var i = 0; i < businessNames.length; i++) {
      var biz = businessNames[i];
      var checklists = report.businesses[biz];
      msg += '*' + biz + '*\n';
      for (var j = 0; j < checklists.length; j++) {
        var cl = checklists[j];
        var icon = cl.status === 'completed' ? '✅' : (cl.escalated ? '🔴' : '⏳');
        msg += icon + ' ' + cl.type;
        if (cl.response) msg += ' — ' + cl.response.substring(0, 80);
        if (cl.status === 'sent') msg += ' — PENDING';
        msg += '\n';
      }
      msg += '\n';
    }

    if (report.total_overdue > 0) {
      msg += '⚠️ ' + report.total_overdue + ' checklist(s) still pending!';
    }

    await _sendTelegram(_rabihChatId, msg);
    console.log('Daily checklist report sent');
  } catch (err) {
    console.error('Daily checklist report error:', err.message);
  }
}

// ========================= CRUD TOOLS =========================

async function createChecklist(business, type, items, sendTime, managerNumber, frequency) {
  var res = await supabase.from('checklists').insert({
    business: business,
    type: type,
    items: items,
    send_time: sendTime,
    manager_number: managerNumber,
    frequency: frequency || 'daily',
    active: true
  }).select();
  if (res.error) return { error: res.error.message };
  return {
    success: true,
    checklist_id: res.data[0].id,
    business: business,
    type: type,
    items_count: items.length,
    send_time: sendTime,
    manager: managerNumber,
    frequency: frequency || 'daily'
  };
}

async function updateChecklist(checklistId, updates) {
  var upd = {};
  if (updates.items) upd.items = updates.items;
  if (updates.send_time) upd.send_time = updates.send_time;
  if (updates.manager_number) upd.manager_number = updates.manager_number;
  if (updates.frequency) upd.frequency = updates.frequency;
  if (typeof updates.active === 'boolean') upd.active = updates.active;
  var res = await supabase.from('checklists').update(upd).eq('id', checklistId);
  if (res.error) return { error: res.error.message };
  return { success: true, updated: checklistId };
}

async function listChecklists(business) {
  var query = supabase.from('checklists').select('*').eq('active', true).order('business');
  if (business) query = query.ilike('business', '%' + business + '%');
  var res = await query;
  if (res.error) return { error: res.error.message };
  return {
    count: (res.data || []).length,
    checklists: (res.data || []).map(function(c) {
      var items = typeof c.items === 'string' ? JSON.parse(c.items) : c.items;
      return {
        id: c.id, business: c.business, type: c.type,
        items: items, send_time: c.send_time,
        manager_number: c.manager_number, frequency: c.frequency
      };
    })
  };
}

async function deleteChecklist(checklistId) {
  var res = await supabase.from('checklists').update({ active: false }).eq('id', checklistId);
  if (res.error) return { error: res.error.message };
  return { success: true, deactivated: checklistId };
}

async function getChecklistStatus(business, date) {
  return await getDailyChecklistReport(date);
}

// ========================= TOOL DEFINITIONS =========================

var checklistTools = [
  {
    name: 'create_checklist',
    description: 'Create a daily checklist for a business. The checklist will be sent automatically via WhatsApp to the designated manager at the scheduled time. Use when Rabih says create checklist, add opening checklist, set up daily checks.',
    input_schema: {
      type: 'object',
      properties: {
        business: { type: 'string', description: 'Business name: BBQ House, SALT, Central Kitchen, Executive Cleaning' },
        type: { type: 'string', description: 'Checklist type: opening, closing, cleaning, inventory, safety, custom' },
        items: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of checklist items, e.g. ["Check fridge temperature", "Verify stock levels", "Clean kitchen surfaces"]'
        },
        send_time: { type: 'string', description: 'Time to send in HH:MM 24h format (Maputo time), e.g. "06:30" for 6:30am' },
        manager_number: { type: 'string', description: 'WhatsApp number of the manager who receives this checklist, e.g. +258841234567' },
        frequency: { type: 'string', description: 'Frequency: daily (default), or comma-separated days e.g. "monday,wednesday,friday"' }
      },
      required: ['business', 'type', 'items', 'send_time', 'manager_number']
    }
  },
  {
    name: 'list_checklists',
    description: 'List all active checklists. Filter by business. Use when Rabih asks what checklists exist, show me checklists.',
    input_schema: {
      type: 'object',
      properties: {
        business: { type: 'string', description: 'Filter by business name' }
      },
      required: []
    }
  },
  {
    name: 'update_checklist',
    description: 'Update a checklist — change items, time, manager, frequency, or deactivate it.',
    input_schema: {
      type: 'object',
      properties: {
        checklist_id: { type: 'string', description: 'Checklist ID to update' },
        items: { type: 'array', items: { type: 'string' }, description: 'New checklist items' },
        send_time: { type: 'string', description: 'New send time HH:MM' },
        manager_number: { type: 'string', description: 'New manager number' },
        frequency: { type: 'string', description: 'New frequency' },
        active: { type: 'boolean', description: 'Set to false to deactivate' }
      },
      required: ['checklist_id']
    }
  },
  {
    name: 'delete_checklist',
    description: 'Deactivate a checklist. Use when Rabih says remove checklist, stop checklist, cancel checklist.',
    input_schema: {
      type: 'object',
      properties: {
        checklist_id: { type: 'string', description: 'Checklist ID to deactivate' }
      },
      required: ['checklist_id']
    }
  },
  {
    name: 'get_checklist_status',
    description: 'Get checklist completion status for today or a specific date. Shows which checklists were completed, pending, or missed across all businesses.',
    input_schema: {
      type: 'object',
      properties: {
        business: { type: 'string', description: 'Filter by business name' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format. Default today.' }
      },
      required: []
    }
  },
  {
    name: 'get_daily_checklist_report',
    description: 'Get the full daily checklist report across BBQ House, SALT, and Central Kitchen. Shows completion rates, responses, and overdue items.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format. Default today.' }
      },
      required: []
    }
  }
];

async function handleChecklistTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'create_checklist': return await createChecklist(toolInput.business, toolInput.type, toolInput.items, toolInput.send_time, toolInput.manager_number, toolInput.frequency);
      case 'list_checklists': return await listChecklists(toolInput.business);
      case 'update_checklist': return await updateChecklist(toolInput.checklist_id, toolInput);
      case 'delete_checklist': return await deleteChecklist(toolInput.checklist_id);
      case 'get_checklist_status': return await getChecklistStatus(toolInput.business, toolInput.date);
      case 'get_daily_checklist_report': return await getDailyChecklistReport(toolInput.date);
      default: return { error: 'Unknown checklist tool: ' + toolName };
    }
  } catch (err) {
    console.error('Checklist tool error:', err.message);
    return { error: err.message };
  }
}

module.exports = {
  checklistTools: checklistTools,
  handleChecklistTool: handleChecklistTool,
  initChecklists: initChecklists,
  processChecklistResponse: processChecklistResponse,
  getDailyChecklistReport: getDailyChecklistReport
};
