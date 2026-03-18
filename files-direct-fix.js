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

async function findFileByName(name) {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: "name contains '" + name.replace(/'/g, "\\'") + "' and trashed = false",
    pageSize: 5,
    fields: 'files(id, name, mimeType)',
    orderBy: 'modifiedTime desc',
  });
  return res.data.files || [];
}

async function readFileByName(fileName, range) {
  const auth = getAuthClient();
  const files = await findFileByName(fileName);
  if (files.length === 0) return { error: 'No file found matching "' + fileName + '"' };
  const file = files[0];
  const mimeType = file.mimeType;
  const drive = google.drive({ version: 'v3', auth });

  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    const sheets = google.sheets({ version: 'v4', auth });
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: file.id,
      range: range || 'A1:Z500',
    });
    const rows = res.data.values || [];
    return { fileId: file.id, fileName: file.name, type: 'spreadsheet', rowCount: rows.length, rows: rows };
  }

  if (mimeType.includes('excel') || mimeType.includes('spreadsheet') || file.name.endsWith('.xlsx') || file.name.endsWith('.xls') || file.name.endsWith('.csv')) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: 'text/csv' },
      { responseType: 'arraybuffer' }
    ).catch(function() { return drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' }); });
    const text = Buffer.from(res.data).toString('utf-8');
    const rows = text.split('\n').filter(function(r) { return r.trim(); }).map(function(r) { return r.split(','); });
    return { fileId: file.id, fileName: file.name, type: 'excel', rowCount: rows.length, rows: rows.slice(0, 200) };
  }

  if (mimeType === 'application/pdf' || file.name.endsWith('.pdf')) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: 'text/plain' },
      { responseType: 'arraybuffer' }
    ).catch(function() { return drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'arraybuffer' }); });
    const text = Buffer.from(res.data).toString('utf-8');
    return { fileId: file.id, fileName: file.name, type: 'pdf', text: text.substring(0, 5000), totalChars: text.length };
  }

  if (mimeType === 'application/vnd.google-apps.document' || file.name.endsWith('.docx')) {
    const res = await drive.files.export(
      { fileId: file.id, mimeType: 'text/plain' },
      { responseType: 'arraybuffer' }
    );
    const text = Buffer.from(res.data).toString('utf-8');
    return { fileId: file.id, fileName: file.name, type: 'document', text: text.substring(0, 5000) };
  }

  if (mimeType === 'text/plain' || file.name.endsWith('.txt') || mimeType.startsWith('text/')) {
    const res = await drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const text = Buffer.from(res.data).toString('utf-8');
    return { fileId: file.id, fileName: file.name, type: 'text', text: text.substring(0, 5000), totalChars: text.length };
  }

  try {
    const res = await drive.files.get(
      { fileId: file.id, alt: 'media' },
      { responseType: 'arraybuffer' }
    );
    const text = Buffer.from(res.data).toString('utf-8');
    return { fileId: file.id, fileName: file.name, type: 'raw', text: text.substring(0, 5000) };
  } catch (e) {
    return { error: 'Cannot read file type: ' + mimeType, fileName: file.name, fileId: file.id };
  }
}

async function searchInFile(fileName, query) {
  const content = await readFileByName(fileName);
  if (content.error) return content;
  var lines = [];
  if (content.rows) {
    lines = content.rows.map(function(r, i) { return 'Row ' + (i + 1) + ': ' + (Array.isArray(r) ? r.join(' | ') : r); });
  } else if (content.text) {
    lines = content.text.split('\n');
  }
  const matches = lines.filter(function(l) { return l.toLowerCase().includes(query.toLowerCase()); });
  return { fileName: content.fileName, query: query, matchCount: matches.length, matches: matches.slice(0, 30) };
}

async function updateSheetCell(fileName, cell, value) {
  const auth = getAuthClient();
  const files = await findFileByName(fileName);
  if (files.length === 0) return { error: 'No file found matching "' + fileName + '"' };
  const file = files[0];
  if (file.mimeType !== 'application/vnd.google-apps.spreadsheet') {
    return { error: '"' + file.name + '" is not a Google Sheet.' };
  }
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.update({
    spreadsheetId: file.id,
    range: cell,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
  return { success: true, fileName: file.name, cell: cell, newValue: value };
}

const filesTools = [
  {
    name: 'read_file',
    description: 'Read the full contents of any file in Google Drive including .txt, Sheets, Excel, PDF, Word.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'File name or partial name to find and read' },
        range: { type: 'string', description: 'For spreadsheets only: cell range like A1:D50.' }
      },
      required: ['file_name']
    }
  },
  {
    name: 'search_in_file',
    description: 'Search for a keyword inside a file in Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'File name to search inside' },
        search_query: { type: 'string', description: 'Text to search for inside the file' }
      },
      required: ['file_name', 'search_query']
    }
  },
  {
    name: 'update_sheet_cell',
    description: 'Update a cell value in a Google Sheet.',
    input_schema: {
      type: 'object',
      properties: {
        file_name: { type: 'string', description: 'Name of the Google Sheet' },
        cell: { type: 'string', description: 'Cell reference like B5' },
        value: { type: 'string', description: 'New value to write' }
      },
      required: ['file_name', 'cell', 'value']
    }
  }
];

async function handleFilesTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'read_file': return await readFileByName(toolInput.file_name, toolInput.range);
      case 'search_in_file': return await searchInFile(toolInput.file_name, toolInput.search_query);
      case 'update_sheet_cell': return await updateSheetCell(toolInput.file_name, toolInput.cell, toolInput.value);
      default: return { error: 'Unknown files tool: ' + toolName };
    }
  } catch (err) {
    console.error('Files tool error (' + toolName + '):', err.message);
    return { error: err.message };
  }
}

module.exports = { filesTools: filesTools, handleFilesTool: handleFilesTool };
