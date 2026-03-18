const { google } = require('googleapis');

function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

async function listCalendarEvents(daysAhead) {
  daysAhead = daysAhead || 7;
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth: auth });
  const tasks = google.tasks({ version: 'v1', auth: auth });
  const now = new Date();
  const future = new Date();
  future.setDate(future.getDate() + daysAhead);
  const allItems = [];

  try {
    const calList = await calendar.calendarList.list();
    for (const cal of (calList.data.items || [])) {
      try {
        const res = await calendar.events.list({
          calendarId: cal.id,
          timeMin: now.toISOString(),
          timeMax: future.toISOString(),
          maxResults: 50,
          singleEvents: true,
          orderBy: 'startTime'
        });
        for (const e of (res.data.items || [])) {
          allItems.push({
            type: 'event',
            id: e.id,
            calendarId: cal.id,
            calendar: cal.summary,
            title: e.summary || '(No title)',
            start: e.start.dateTime || e.start.date,
            end: e.end.dateTime || e.end.date,
            location: e.location || '',
            status: e.status
          });
        }
      } catch (err) { console.log('Skipping calendar:', cal.summary, err.message); }
    }
  } catch (err) { console.log('Calendar list error:', err.message); }

  try {
    const taskLists = await tasks.tasklists.list();
    for (const tl of (taskLists.data.items || [])) {
      try {
        const res = await tasks.tasks.list({
          tasklist: tl.id,
          showCompleted: false,
          showHidden: false,
          dueMax: future.toISOString(),
          maxResults: 50
        });
        for (const t of (res.data.items || [])) {
          if (t.status !== 'completed') {
            allItems.push({
              type: 'task',
              calendar: tl.title,
              title: t.title || '(No title)',
              start: t.due || t.updated || '',
              end: '',
              notes: t.notes || '',
              status: t.status
            });
          }
        }
      } catch (err) { console.log('Skipping task list:', tl.title, err.message); }
    }
  } catch (err) { console.log('Tasks list error:', err.message); }

  allItems.sort(function(a, b) {
    if (!a.start) return 1;
    if (!b.start) return -1;
    return new Date(a.start) - new Date(b.start);
  });

  return { count: allItems.length, events: allItems };
}

async function createCalendarEvent(title, date, time, durationMinutes) {
  durationMinutes = durationMinutes || 60;
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth: auth });
  const parts = time.split(':');
  const startH = parseInt(parts[0]);
  const startM = parseInt(parts[1]);
  const totalEndMins = startH * 60 + startM + durationMinutes;
  const endH = Math.floor(totalEndMins / 60) % 24;
  const endM = totalEndMins % 60;
  const endTime = String(endH).padStart(2, '0') + ':' + String(endM).padStart(2, '0');
  const event = {
    summary: title,
    start: { dateTime: date + 'T' + time + ':00', timeZone: 'Africa/Maputo' },
    end: { dateTime: date + 'T' + endTime + ':00', timeZone: 'Africa/Maputo' },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] }
  };
  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
  return { success: true, eventId: res.data.id, title: title, start: res.data.start.dateTime };
}

async function deleteCalendarEvent(titleKeyword, date) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth: auth });
  const searchStart = new Date(date);
  searchStart.setHours(0, 0, 0, 0);
  const searchEnd = new Date(searchStart);
  searchEnd.setDate(searchEnd.getDate() + 1);
  const calList = await calendar.calendarList.list();
  const deleted = [];
  const errors = [];
  for (const cal of (calList.data.items || [])) {
    try {
      const res = await calendar.events.list({
        calendarId: cal.id,
        timeMin: searchStart.toISOString(),
        timeMax: searchEnd.toISOString(),
        maxResults: 50,
        singleEvents: true
      });
      for (const e of (res.data.items || [])) {
        const title = (e.summary || '').toLowerCase();
        const keyword = titleKeyword.toLowerCase();
        if (title.includes(keyword)) {
          await calendar.events.delete({ calendarId: cal.id, eventId: e.id });
          deleted.push({ title: e.summary, calendar: cal.summary, start: e.start.dateTime || e.start.date });
        }
      }
    } catch (err) { errors.push(cal.summary + ': ' + err.message); }
  }
  if (deleted.length === 0) {
    return { success: false, message: 'No events found matching "' + titleKeyword + '" on ' + date, errors: errors };
  }
  return { success: true, deleted: deleted, count: deleted.length };
}

const calendarTools = [
  {
    name: 'list_calendar_events',
    description: 'List upcoming calendar events and tasks across all calendars.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'number', description: 'How many days ahead to look. Default 7.' }
      },
      required: []
    }
  },
  {
    name: 'create_calendar_event',
    description: 'Create an event or reminder in Google Calendar. Time is Maputo time (UTC+2).',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        time: { type: 'string', description: 'Time in HH:MM 24h format' },
        duration_minutes: { type: 'number', description: 'Duration in minutes, default 60' }
      },
      required: ['title', 'date', 'time']
    }
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete a calendar event by title keyword and date. Use when Rabih says remove, delete, or cancel an event.',
    input_schema: {
      type: 'object',
      properties: {
        title_keyword: { type: 'string', description: 'Part of the event title to match' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' }
      },
      required: ['title_keyword', 'date']
    }
  }
];

async function handleCalendarTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'list_calendar_events': return await listCalendarEvents(toolInput.days_ahead || 7);
      case 'create_calendar_event': return await createCalendarEvent(toolInput.title, toolInput.date, toolInput.time, toolInput.duration_minutes || 60);
      case 'delete_calendar_event': return await deleteCalendarEvent(toolInput.title_keyword, toolInput.date);
      default: return { error: 'Unknown calendar tool: ' + toolName };
    }
  } catch (err) {
    console.error('Calendar tool error (' + toolName + '):', err.message);
    return { error: err.message };
  }
}

module.exports = { calendarTools: calendarTools, handleCalendarTool: handleCalendarTool };
