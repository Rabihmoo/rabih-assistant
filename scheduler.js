const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

var _executeTool = null;
var _sendTelegram = null;
var _rabihChatId = null;

function initScheduler(executeTool, sendTelegram, rabihChatId) {
  _executeTool = executeTool;
  _sendTelegram = sendTelegram;
  _rabihChatId = rabihChatId;

  // Check for due tasks every minute
  cron.schedule('* * * * *', function() {
    checkAndExecuteDueTasks().catch(function(err) {
      console.error('Scheduler cron error:', err.message);
    });
  });
  console.log('Scheduler started — checking every minute for due tasks');
}

async function checkAndExecuteDueTasks() {
  var now = new Date().toISOString();
  var res = await supabase.from('scheduled_tasks')
    .select('*')
    .eq('done', false)
    .lte('run_at', now)
    .order('run_at')
    .limit(10);

  if (res.error || !res.data || res.data.length === 0) return;

  for (var i = 0; i < res.data.length; i++) {
    var task = res.data[i];
    console.log('Executing scheduled task:', task.type, JSON.stringify(task.payload));
    try {
      var result = null;
      var payload = typeof task.payload === 'string' ? JSON.parse(task.payload) : task.payload;
      console.log('Scheduled task payload:', JSON.stringify(payload));

      switch (task.type) {
        case 'whatsapp':
        case 'send_whatsapp_message':
          var phone = payload.phone_number || payload.to || payload.number || payload.jid || payload.recipient || payload.group_id || payload.phone || '';
          if (!phone) {
            console.error('Scheduler WhatsApp — no phone found in payload:', JSON.stringify(payload));
            result = { error: 'No phone number found in scheduled task payload. Fields present: ' + Object.keys(payload).join(', ') + '. Full payload: ' + JSON.stringify(payload) };
            break;
          }
          var msg = payload.message || payload.text || payload.body || '';
          console.log('Scheduler WhatsApp — phone:', phone, 'message:', msg.substring(0, 50));
          result = await _executeTool('send_whatsapp_message', { phone_number: phone, message: msg });
          break;
        case 'email':
          result = await _executeTool('send_email', { to: payload.to || payload.email || '', subject: payload.subject || '', body: payload.body || payload.message || '' });
          break;
        case 'reminder':
          // Just send a Telegram notification
          if (_sendTelegram) await _sendTelegram(_rabihChatId, 'Reminder: ' + payload.message);
          result = { success: true };
          break;
        case 'calendar':
          result = await _executeTool('create_calendar_event', payload);
          break;
        default:
          // Generic tool execution
          if (payload.tool_name) {
            result = await _executeTool(payload.tool_name, payload.tool_input || {});
          } else {
            result = { error: 'Unknown scheduled task type: ' + task.type };
          }
      }

      // Mark as done
      await supabase.from('scheduled_tasks').update({ done: true }).eq('id', task.id);

      // Notify Rabih
      var summary = 'Scheduled ' + task.type + ' executed';
      if (result && result.success) {
        summary += ' successfully';
        if (task.type === 'whatsapp') summary += ': sent to ' + payload.phone;
        if (task.type === 'email') summary += ': sent to ' + payload.to;
      } else if (result && result.error) {
        summary += ' with error: ' + result.error;
      }
      if (_sendTelegram) await _sendTelegram(_rabihChatId, summary);
      console.log('Scheduled task completed:', summary);
    } catch (err) {
      console.error('Scheduled task error:', err.message);
      // Mark as done to prevent infinite retries
      await supabase.from('scheduled_tasks').update({ done: true }).eq('id', task.id);
      if (_sendTelegram) await _sendTelegram(_rabihChatId, 'Scheduled ' + task.type + ' failed: ' + err.message);
    }
  }
}

async function scheduleAction(type, payload, runAt, description) {
  var res = await supabase.from('scheduled_tasks').insert({
    type: type,
    payload: payload,
    run_at: runAt,
    description: description || '',
    done: false
  });
  if (res.error) return { error: res.error.message };
  return {
    success: true,
    type: type,
    scheduled_for: runAt,
    description: description || type + ' action'
  };
}

async function listScheduledTasks(showDone) {
  var query = supabase.from('scheduled_tasks').select('*').order('run_at');
  if (!showDone) query = query.eq('done', false);
  var res = await query.limit(20);
  if (res.error) return { error: res.error.message };
  return {
    count: (res.data || []).length,
    tasks: (res.data || []).map(function(t) {
      return { id: t.id, type: t.type, description: t.description, run_at: t.run_at, done: t.done, payload: t.payload };
    })
  };
}

async function cancelScheduledTask(taskId) {
  var res = await supabase.from('scheduled_tasks').delete().eq('id', taskId).eq('done', false);
  if (res.error) return { error: res.error.message };
  return { success: true, cancelled: taskId };
}

var schedulerTools = [
  {
    name: 'schedule_action',
    description: 'Schedule a future action: send WhatsApp, send email, reminder, or any task at a specific time. Use when Rabih says "tomorrow at 9am", "on Monday", "in 2 hours", "later at 5pm".',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Action type: whatsapp, email, reminder, calendar' },
        payload: {
          type: 'object',
          description: 'Action data. For whatsapp: {phone, message}. For email: {to, subject, body}. For reminder: {message}. For calendar: {title, date, time}.'
        },
        run_at: { type: 'string', description: 'When to execute, in ISO 8601 format (e.g. 2026-03-21T09:00:00+02:00). Always use Maputo timezone UTC+2.' },
        description: { type: 'string', description: 'Human-readable description of what this scheduled action does' }
      },
      required: ['type', 'payload', 'run_at']
    }
  },
  {
    name: 'list_scheduled',
    description: 'List upcoming scheduled actions. Use when Rabih asks what\'s scheduled, what\'s pending, upcoming actions.',
    input_schema: {
      type: 'object',
      properties: {
        show_done: { type: 'boolean', description: 'Include completed tasks. Default false.' }
      },
      required: []
    }
  },
  {
    name: 'cancel_scheduled',
    description: 'Cancel a scheduled action by its ID.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The scheduled task ID to cancel' }
      },
      required: ['task_id']
    }
  }
];

async function handleSchedulerTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'schedule_action': return await scheduleAction(toolInput.type, toolInput.payload, toolInput.run_at, toolInput.description);
      case 'list_scheduled': return await listScheduledTasks(toolInput.show_done || false);
      case 'cancel_scheduled': return await cancelScheduledTask(toolInput.task_id);
      default: return { error: 'Unknown scheduler tool: ' + toolName };
    }
  } catch (err) {
    console.error('Scheduler tool error:', err.message);
    return { error: err.message };
  }
}

module.exports = { schedulerTools: schedulerTools, handleSchedulerTool: handleSchedulerTool, initScheduler: initScheduler };
