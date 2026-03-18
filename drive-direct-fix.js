const { google } = require('googleapis');

function getDriveClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth: oauth2Client });
}

async function searchDrive(query) {
  const drive = getDriveClient();
  const res = await drive.files.list({
    q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    pageSize: 20,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink, size)',
    orderBy: 'modifiedTime desc',
  });
  const files = res.data.files || [];
  return {
    count: files.length,
    files: files.map(f => ({
      id: f.id,
      name: f.name,
      type: f.mimeType.split('application/vnd.google-apps.').pop(),
      modified: f.modifiedTime,
      link: f.webViewLink,
    }))
  };
}

async function listDriveFiles() {
  const drive = getDriveClient();
  const res = await drive.files.list({
    pageSize: 20,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
    orderBy: 'modifiedTime desc',
    q: 'trashed = false',
  });
  const files = res.data.files || [];
  return {
    count: files.length,
    files: files.map(f => ({
      id: f.id,
      name: f.name,
      type: f.mimeType.split('application/vnd.google-apps.').pop(),
      modified: f.modifiedTime,
      link: f.webViewLink,
    }))
  };
}

async function deleteDriveFile(fileId, fileName) {
  const drive = getDriveClient();
  await drive.files.delete({ fileId });
  return { success: true, deleted: fileName || fileId };
}

const driveTools = [
  {
    name: 'search_drive',
    description: "Search for files in Rabih's Google Drive by name or keyword.",
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term or filename to look for' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_drive_files',
    description: "List the most recently modified files in Rabih's Google Drive.",
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'delete_drive_file',
    description: "Permanently delete a file from Rabih's Google Drive. Use the file ID from search_drive or list_drive_files results.",
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The Google Drive file ID to delete' },
        file_name: { type: 'string', description: 'The file name (for confirmation message)' }
      },
      required: ['file_id']
    }
  }
];

async function handleDriveTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'search_drive':
        return await searchDrive(toolInput.query);
      case 'list_drive_files':
        return await listDriveFiles();
      case 'delete_drive_file':
        return await deleteDriveFile(toolInput.file_id, toolInput.file_name);
      default:
        return { error: `Unknown drive tool: ${toolName}` };
    }
  } catch (err) {
    console.error(`Drive tool error (${toolName}):`, err.message);
    return { error: err.message };
  }
}

module.exports = { driveTools, handleDriveTool };
