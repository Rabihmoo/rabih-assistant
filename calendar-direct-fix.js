const { google } = require('googleapis');

function getCalendarClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

async function listCalendarEvents(daysAhead = 7) {
  const calendar = getCalendarClient();
  const now = new Date();
  const future = new Date();
  future.setDate(future.getDate() + daysAhead);
  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: now.toISOString(),
    timeMax: future.toISOString(),
    maxResults: 50,
    singleEvents: true,
    orderBy: 'startTime',
  });
  const events = res.data.items || [];
  if (events.length === 0) return { count: 0, events: [] };
  return {
    count: events.length,
    events: events.map(e => ({
      id: e.id,
      title: e.summary || '(No title)',
      start: e.start.dateTime || e.start.date,
      end: e.end.dateTime || e.end.date,
      location: e.location || '',
      description: e.description || '',
      status: e.status,
    }))
  };
}

async function createCalendarEvent(title, date, time, durationMinutes = 60) {
  const calendar = getCalendarClient();
  const startDateTime = new Date(`${date}T${time}:00`);
  const endDateTime = new Date(startDateTime.getTime() + durationMinutes * 60000);
  const event = {
    summary: title,
    start: { dateTime: startDateTime.toISOString(), timeZone: 'Africa/Maputo' },
    end: { dateTime: endDateTime.toISOString(), timeZone: 'Africa/Maputo' },
    reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
  };
  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
  return { success: true, eventId: res.data.id, title, start: res.data.start.dateTime };
}

const calendarTools = [
  {
    name: 'list_calendar_events',
    description: "List Rabih's upcoming calendar events. Use for 'what do I have this week', 'show my schedule', 'upcoming events'.",
    input_schema: {
      type: 'object',
      properties: { days_ahead: { type: 'number', description: 'How many days ahead to look. Default 7.' } },
      required: []
    }
  },
  {
    name: 'create_calendar_event',
    description: "Create an event or reminder in Rabih's Google Calendar.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        time: { type: 'string', description: 'Time in HH:MM 24h format' },
        duration_minutes: { type: 'number', description: 'Duration in minutes, default 60' },
        is_reminder: { type: 'boolean', description: 'True if this is a reminder' }
      },
      required: ['title', 'date', 'time']
    }
  }
];

async function handleCalendarTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'list_calendar_events':
        return await listCalendarEvents(toolInput.days_ahead || 7);
      case 'create_calendar_event':
        return await createCalendarEvent(toolInput.title, toolInput.date, toolInput.time, toolInput.duration_minutes || 60);
      default:
        return { error: `Unknown calendar tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`Calendar tool error (${toolName}):`, err.message);
    return { error: err.message };
  }
}

module.exports = { calendarTools, handleCalendarTool };
