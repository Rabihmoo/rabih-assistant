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
    q: "name contains '" + query.replace(/'/g, "\\'") + "' and trashed = false",
    pageSize: 20,
    fields: 'files(id, name, mimeType, modifiedTime, webViewLink, size)',
    orderBy: 'modifiedTime desc',
  });
  const files = res.data.files || [];
  return {
    count: files.length,
    files: files.map(function(f) {
      return { id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, link: f.webViewLink };
    })
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
    files: files.map(function(f) {
      return { id: f.id, name: f.name, type: f.mimeType, modified: f.modifiedTime, link: f.webViewLink };
    })
  };
}

async function deleteDriveFile(fileId, fileName) {
  const drive = getDriveClient();
  await drive.files.delete({ fileId: fileId });
  return { success: true, deleted: fileName || fileId };
}

async function renameDriveFile(fileId, newName) {
  const drive = getDriveClient();
  const res = await drive.files.update({
    fileId: fileId,
    requestBody: { name: newName }
  });
  return { success: true, fileId: fileId, newName: res.data.name };
}

async function renameDriveFileByName(currentName, newName) {
  const drive = getDriveClient();
  const res = await drive.files.list({
    q: "name = '" + currentName.replace(/'/g, "\\'") + "' and trashed = false",
    pageSize: 5,
    fields: 'files(id, name)',
  });
  const files = res.data.files || [];
  if (files.length === 0) return { error: 'No file found with name: ' + currentName };
  const file = files[0];
  const updated = await drive.files.update({
    fileId: file.id,
    requestBody: { name: newName }
  });
  return { success: true, oldName: currentName, newName: updated.data.name };
}

const driveTools = [
  {
    name: 'search_drive',
    description: 'Search for files in Google Drive by name or keyword.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search term or filename' } },
      required: ['query']
    }
  },
  {
    name: 'list_drive_files',
    description: 'List the most recently modified files in Google Drive.',
    input_schema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'delete_drive_file',
    description: 'Permanently delete a file from Google Drive.',
    input_schema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: 'The Google Drive file ID' },
        file_name: { type: 'string', description: 'The file name for confirmation' }
      },
      required: ['file_id']
    }
  },
  {
    name: 'rename_drive_file',
    description: 'Rename a file in Google Drive. Use when Rabih says rename, change name of a file.',
    input_schema: {
      type: 'object',
      properties: {
        current_name: { type: 'string', description: 'Current name of the file to rename' },
        new_name: { type: 'string', description: 'New name for the file' }
      },
      required: ['current_name', 'new_name']
    }
  }
];

async function handleDriveTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'search_drive': return await searchDrive(toolInput.query);
      case 'list_drive_files': return await listDriveFiles();
      case 'delete_drive_file': return await deleteDriveFile(toolInput.file_id, toolInput.file_name);
      case 'rename_drive_file': return await renameDriveFileByName(toolInput.current_name, toolInput.new_name);
      default: return { error: 'Unknown drive tool: ' + toolName };
    }
  } catch (err) {
    console.error('Drive tool error (' + toolName + '):', err.message);
    return { error: err.message };
  }
}

module.exports = { driveTools: driveTools, handleDriveTool: handleDriveTool };
