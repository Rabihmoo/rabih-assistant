const { google } = require('googleapis');

const EXPENSE_SHEET_NAME = 'Rabih Expenses';

function getAuthClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
  return oauth2Client;
}

async function findOrCreateExpenseSheet() {
  const auth = getAuthClient();
  const drive = google.drive({ version: 'v3', auth: auth });
  const sheets = google.sheets({ version: 'v4', auth: auth });

  const res = await drive.files.list({
    q: "name = '" + EXPENSE_SHEET_NAME + "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false",
    pageSize: 1,
    fields: 'files(id, name)'
  });

  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id;
  }

  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: EXPENSE_SHEET_NAME },
      sheets: [{
        properties: { title: 'Expenses' },
        data: [{ rowData: [{ values: [
          { userEnteredValue: { stringValue: 'Date' } },
          { userEnteredValue: { stringValue: 'Amount (USD)' } },
          { userEnteredValue: { stringValue: 'Category' } },
          { userEnteredValue: { stringValue: 'Business' } },
          { userEnteredValue: { stringValue: 'Description' } },
          { userEnteredValue: { stringValue: 'Added By' } }
        ]}]}]
      }]
    }
  });
  return created.data.spreadsheetId;
}

async function logExpense(amount, category, business, description) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: auth });
  const sheetId = await findOrCreateExpenseSheet();

  const now = new Date();
  const date = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });

  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: 'Expenses!A:F',
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values: [[date, amount, category || 'General', business || 'Rabih Group', description || '', 'Rabih']]
    }
  });

  return {
    success: true,
    logged: { date: date, amount: amount, category: category, business: business, description: description },
    sheetId: sheetId
  };
}

async function getExpenseSummary(period) {
  const auth = getAuthClient();
  const sheets = google.sheets({ version: 'v4', auth: auth });
  const sheetId = await findOrCreateExpenseSheet();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: 'Expenses!A:F'
  });

  const rows = (res.data.values || []).slice(1);
  if (rows.length === 0) return { success: true, message: 'No expenses logged yet.', total: 0 };

  const now = new Date();
  let filtered = rows;

  if (period === 'today') {
    const today = now.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
    filtered = rows.filter(function(r) { return r[0] === today; });
  } else if (period === 'week') {
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    filtered = rows.filter(function(r) {
      if (!r[0]) return false;
      const parts = r[0].split('/');
      const d = new Date(parts[2] + '-' + parts[1] + '-' + parts[0]);
      return d >= weekAgo;
    });
  } else if (period === 'month') {
    const thisMonth = now.getMonth();
    const thisYear = now.getFullYear();
    filtered = rows.filter(function(r) {
      if (!r[0]) return false;
      const parts = r[0].split('/');
      const d = new Date(parts[2] + '-' + parts[1] + '-' + parts[0]);
      return d.getMonth() === thisMonth && d.getFullYear() === thisYear;
    });
  }

  const total = filtered.reduce(function(sum, r) { return sum + (parseFloat(r[1]) || 0); }, 0);

  const byBusiness = {};
  filtered.forEach(function(r) {
    const biz = r[3] || 'Unknown';
    byBusiness[biz] = (byBusiness[biz] || 0) + (parseFloat(r[1]) || 0);
  });

  return {
    success: true,
    period: period || 'all',
    count: filtered.length,
    total: total.toFixed(2),
    byBusiness: byBusiness,
    recent: filtered.slice(-5).reverse()
  };
}

const expenseTools = [
  {
    name: 'log_expense',
    description: 'Log an expense to the Rabih Expenses Google Sheet. Use when Rabih says he spent money, paid for something, or bought something.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount spent in USD or local currency' },
        category: { type: 'string', description: 'Category e.g. Supplies, Food, Transport, Salary, Rent, Utilities, Marketing' },
        business: { type: 'string', description: 'Which business: BBQ House, SALT, Central Kitchen, Executive Cleaning, or Rabih Group' },
        description: { type: 'string', description: 'Short description of what the expense was for' }
      },
      required: ['amount', 'category', 'business']
    }
  },
  {
    name: 'get_expense_summary',
    description: 'Get a summary of expenses. Use when Rabih asks how much was spent, expense report, or spending summary.',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'Time period: today, week, month, or all' }
      },
      required: ['period']
    }
  }
];

async function handleExpenseTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'log_expense': return await logExpense(toolInput.amount, toolInput.category, toolInput.business, toolInput.description);
      case 'get_expense_summary': return await getExpenseSummary(toolInput.period);
      default: return { error: 'Unknown expense tool: ' + toolName };
    }
  } catch (err) {
    console.error('Expense tool error (' + toolName + '):', err.message);
    return { error: err.message };
  }
}

module.exports = { expenseTools: expenseTools, handleExpenseTool: handleExpenseTool };
