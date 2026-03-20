const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function logInvoice(vendor, amount, currency, dueDate, description, business) {
  var res = await supabase.from('invoices').insert({
    vendor: vendor,
    amount: amount,
    currency: currency || 'USD',
    due_date: dueDate || null,
    description: description || '',
    business: business || 'Rabih Group',
    paid: false
  });
  if (res.error) return { error: res.error.message };
  return { success: true, vendor: vendor, amount: amount, currency: currency || 'USD', due_date: dueDate };
}

async function listUnpaidInvoices(business) {
  var query = supabase.from('invoices').select('*').eq('paid', false).order('due_date');
  if (business) query = query.ilike('business', '%' + business + '%');
  var res = await query.limit(30);
  if (res.error) return { error: res.error.message };
  var total = (res.data || []).reduce(function(sum, inv) { return sum + (parseFloat(inv.amount) || 0); }, 0);
  var overdue = (res.data || []).filter(function(inv) {
    return inv.due_date && new Date(inv.due_date) < new Date();
  });
  return {
    count: (res.data || []).length,
    total: total.toFixed(2),
    overdue_count: overdue.length,
    invoices: (res.data || []).map(function(inv) {
      return {
        id: inv.id, vendor: inv.vendor, amount: inv.amount, currency: inv.currency,
        due_date: inv.due_date, description: inv.description, business: inv.business,
        is_overdue: inv.due_date && new Date(inv.due_date) < new Date()
      };
    })
  };
}

async function markInvoicePaid(vendorKeyword) {
  var res = await supabase.from('invoices').select('id, vendor, amount, currency')
    .eq('paid', false).ilike('vendor', '%' + vendorKeyword + '%').limit(5);
  if (res.error) return { error: res.error.message };
  if (!res.data || res.data.length === 0) return { error: 'No unpaid invoice found matching: ' + vendorKeyword };
  var inv = res.data[0];
  var upd = await supabase.from('invoices').update({ paid: true, paid_at: new Date().toISOString() }).eq('id', inv.id);
  if (upd.error) return { error: upd.error.message };
  return { success: true, marked_paid: inv.vendor, amount: inv.amount, currency: inv.currency };
}

async function getOverdueInvoices() {
  var today = new Date().toISOString().split('T')[0];
  var res = await supabase.from('invoices').select('*').eq('paid', false).lt('due_date', today).order('due_date');
  if (res.error) return [];
  return res.data || [];
}

var invoiceTools = [
  {
    name: 'log_invoice',
    description: 'Log a new invoice or bill to track. Use when Rabih mentions an invoice, bill, payment due, or amount owed.',
    input_schema: {
      type: 'object',
      properties: {
        vendor: { type: 'string', description: 'Vendor or supplier name' },
        amount: { type: 'number', description: 'Invoice amount' },
        currency: { type: 'string', description: 'Currency: USD, MZN, LBP. Default USD.' },
        due_date: { type: 'string', description: 'Due date YYYY-MM-DD' },
        description: { type: 'string', description: 'What the invoice is for' },
        business: { type: 'string', description: 'Which business: BBQ House, SALT, Central Kitchen, Executive Cleaning, Rabih Group' }
      },
      required: ['vendor', 'amount']
    }
  },
  {
    name: 'list_unpaid_invoices',
    description: 'List all unpaid invoices. Shows overdue ones. Use when Rabih asks about pending bills, what we owe, invoices.',
    input_schema: {
      type: 'object',
      properties: {
        business: { type: 'string', description: 'Filter by business name' }
      },
      required: []
    }
  },
  {
    name: 'mark_invoice_paid',
    description: 'Mark an invoice as paid. Use when Rabih says he paid a vendor or settled a bill.',
    input_schema: {
      type: 'object',
      properties: {
        vendor_keyword: { type: 'string', description: 'Vendor name or partial match' }
      },
      required: ['vendor_keyword']
    }
  }
];

async function handleInvoiceTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'log_invoice': return await logInvoice(toolInput.vendor, toolInput.amount, toolInput.currency, toolInput.due_date, toolInput.description, toolInput.business);
      case 'list_unpaid_invoices': return await listUnpaidInvoices(toolInput.business);
      case 'mark_invoice_paid': return await markInvoicePaid(toolInput.vendor_keyword);
      default: return { error: 'Unknown invoice tool: ' + toolName };
    }
  } catch (err) {
    console.error('Invoice tool error:', err.message);
    return { error: err.message };
  }
}

module.exports = { invoiceTools: invoiceTools, handleInvoiceTool: handleInvoiceTool, getOverdueInvoices: getOverdueInvoices };
