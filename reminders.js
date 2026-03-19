const { google } = require('googleapis');
const axios = require('axios');

// In-memory reminder store (persists as calendar events)
function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

async function setReminder(title, date, time) {
  const auth = getAuthClient();
  const calendar = google.calendar({ version: 'v3', auth: auth });

  const startDateTime = date + 'T' + time + ':00';
  const event = {
    summary: 'REMINDER: ' + title,
    start: { dateTime: startDateTime, timeZone: 'Africa/Maputo' },
    end: { dateTime: startDateTime, timeZone: 'Africa/Maputo' },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 0 },
        { method: 'popup', minutes: 10 }
      ]
    }
  };

  const res = await calendar.events.insert({ calendarId: 'primary', requestBody: event });
  return {
    success: true,
    reminder: title,
    scheduledFor: date + ' at ' + time + ' (Maputo time)',
    eventId: res.data.id
  };
}

async function addSupplierContact(name, company, email, phone, category, notes) {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth: auth });
  const sheets = google.sheets({ version: 'v4', auth: auth });

  const SHEET_NAME = 'Rabih Suppliers';
  const res = await drive.files.list({
    q: "name = '" + SHEET_NAME + "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
    pageSize: 1, fields: 'files(id)'
  });

  let sheetId;
  if (res.data.files && res.data.files.length > 0) {
    sheetId = res.data.files[0].id;
  } else {
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: SHEET_NAME },
        sheets: [{ properties: { title: 'Suppliers' }, data: [{ rowData: [{ values: [
          { userEnteredValue: { stringValue: 'Name' } },
          { userEnteredValue: { stringValue: 'Company' } },
          { userEnteredValue: { stringValue: 'Email' } },
          { userEnteredValue: { stringValue: 'Phone' } },
          { userEnteredValue: { stringValue: 'Category' } },
          { userEnteredValue: { stringValue: 'Notes' } }
        ]}]}] }]
      }
    });
    sheetId = created.data.spreadsheetId;
  }

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Suppliers!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[name || '', company || '', email || '', phone || '', category || '', notes || '']] }
  });

  return { success: true, added: { name: name, company: company, email: email } };
}

async function findSupplierContact(query) {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth: auth });
  const sheets = google.sheets({ version: 'v4', auth: auth });

  const SHEET_NAME = 'Rabih Suppliers';
  const res = await drive.files.list({
    q: "name = '" + SHEET_NAME + "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
    pageSize: 1, fields: 'files(id)'
  });

  if (!res.data.files || res.data.files.length === 0) return { error: 'No suppliers sheet found. Add suppliers first.' };

  const data = await sheets.spreadsheets.values.get({
    spreadsheetId: res.data.files[0].id,
    range: 'Suppliers!A:F'
  });

  const rows = (data.data.values || []).slice(1);
  const q = query.toLowerCase();
  const matches = rows.filter(function(r) {
    return (r[0] || '').toLowerCase().includes(q) ||
           (r[1] || '').toLowerCase().includes(q) ||
           (r[4] || '').toLowerCase().includes(q);
  });

  if (matches.length === 0) return { error: 'No supplier found matching: ' + query };
  return {
    count: matches.length,
    suppliers: matches.map(function(r) {
      return { name: r[0], company: r[1], email: r[2], phone: r[3], category: r[4], notes: r[5] };
    })
  };
}

const reminderTools = [
  {
    name: 'set_reminder',
    description: 'Set a reminder for Rabih at a specific date and time. Creates a calendar event with popup alert. Use when Rabih says remind me, dont forget, alert me.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What to remind Rabih about' },
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        time: { type: 'string', description: 'Time in HH:MM 24h format (Maputo time)' }
      },
      required: ['title', 'date', 'time']
    }
  },
  {
    name: 'add_supplier',
    description: 'Add a new supplier or contact to the Rabih Suppliers Google Sheet.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact person name' },
        company: { type: 'string', description: 'Company or supplier name' },
        email: { type: 'string', description: 'Email address' },
        phone: { type: 'string', description: 'Phone number' },
        category: { type: 'string', description: 'Category e.g. Food Supplier, Cleaning, Beverages, Equipment, Logistics' },
        notes: { type: 'string', description: 'Any notes about this supplier' }
      },
      required: ['name', 'company']
    }
  },
  {
    name: 'find_supplier',
    description: 'Find a supplier or contact by name, company, or category.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, company, or category to search for' }
      },
      required: ['query']
    }
  }
];

async function handleReminderTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'set_reminder': return await setReminder(toolInput.title, toolInput.date, toolInput.time);
      case 'add_supplier': return await addSupplierContact(toolInput.name, toolInput.company, toolInput.email, toolInput.phone, toolInput.category, toolInput.notes);
      case 'find_supplier': return await findSupplierContact(toolInput.query);
      default: return { error: 'Unknown tool: ' + toolName };
    }
  } catch (err) {
    console.error('Reminder/supplier tool error (' + toolName + '):', err.message);
    return { error: err.message };
  }
}

module.exports = { reminderTools: reminderTools, handleReminderTool: handleReminderTool };
