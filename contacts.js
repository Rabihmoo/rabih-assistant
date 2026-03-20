const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function addContact(name, phone, whatsapp, email, category, notes) {
  var existing = await supabase.from('contacts').select('id').ilike('name', name).limit(1);
  if (existing.data && existing.data.length > 0) {
    var updates = {};
    if (phone) updates.phone = phone;
    if (whatsapp) updates.whatsapp = whatsapp;
    if (email) updates.email = email;
    if (category) updates.category = category;
    if (notes) updates.notes = notes;
    var res = await supabase.from('contacts').update(updates).eq('id', existing.data[0].id);
    if (res.error) return { error: res.error.message };
    return { success: true, action: 'updated', name: name };
  }
  var ins = await supabase.from('contacts').insert({
    name: name,
    phone: phone || '',
    whatsapp: whatsapp || phone || '',
    email: email || '',
    category: category || 'general',
    notes: notes || ''
  });
  if (ins.error) return { error: ins.error.message };
  return { success: true, action: 'added', name: name };
}

async function findContact(query) {
  var q = '%' + query + '%';
  var res = await supabase.from('contacts').select('*')
    .or('name.ilike.' + q + ',phone.ilike.' + q + ',email.ilike.' + q + ',category.ilike.' + q + ',notes.ilike.' + q);
  if (res.error) return { error: res.error.message };
  if (!res.data || res.data.length === 0) return { error: 'No contact found matching: ' + query };
  return {
    count: res.data.length,
    contacts: res.data.map(function(c) {
      return { name: c.name, phone: c.phone, whatsapp: c.whatsapp, email: c.email, category: c.category, notes: c.notes };
    })
  };
}

async function listContacts(category) {
  var query = supabase.from('contacts').select('*').order('name');
  if (category) query = query.ilike('category', '%' + category + '%');
  var res = await query;
  if (res.error) return { error: res.error.message };
  return {
    count: (res.data || []).length,
    contacts: (res.data || []).map(function(c) {
      return { name: c.name, phone: c.phone, whatsapp: c.whatsapp, email: c.email, category: c.category, notes: c.notes };
    })
  };
}

async function resolveContact(nameOrNumber) {
  var cleaned = nameOrNumber.replace(/[\s\-]/g, '');
  if (/^\+?\d{8,}$/.test(cleaned)) return { phone: nameOrNumber };
  var result = await findContact(nameOrNumber);
  if (result.error) return { error: 'Contact not found: ' + nameOrNumber };
  var contact = result.contacts[0];
  return { phone: contact.whatsapp || contact.phone, name: contact.name, email: contact.email };
}

async function isApprovedContact(phoneNumber) {
  var cleaned = phoneNumber.replace(/[^0-9]/g, '');
  var res = await supabase.from('contacts').select('name, category')
    .or('phone.ilike.%' + cleaned + '%,whatsapp.ilike.%' + cleaned + '%')
    .limit(1);
  if (res.data && res.data.length > 0) return res.data[0];
  return null;
}

var contactsTools = [
  {
    name: 'add_contact',
    description: 'Add or update a contact in Rabih\'s address book. Use when Rabih mentions a person with their number, email, or wants to save a contact.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Contact name (e.g. Karim, Mama, Ahmad)' },
        phone: { type: 'string', description: 'Phone number with country code e.g. +258841234567' },
        whatsapp: { type: 'string', description: 'WhatsApp number if different from phone' },
        email: { type: 'string', description: 'Email address' },
        category: { type: 'string', description: 'Category: family, friend, staff, supplier, business, other' },
        notes: { type: 'string', description: 'Any notes about this contact' }
      },
      required: ['name']
    }
  },
  {
    name: 'find_contact',
    description: 'Find a contact by name, phone, email, or category. Use this to look up phone numbers and emails before sending messages. ALWAYS use this when Rabih refers to someone by name.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name, phone, email, or category to search' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_contacts',
    description: 'List all contacts or filter by category.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category: family, friend, staff, supplier, business' }
      },
      required: []
    }
  }
];

async function handleContactTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'add_contact': return await addContact(toolInput.name, toolInput.phone, toolInput.whatsapp, toolInput.email, toolInput.category, toolInput.notes);
      case 'find_contact': return await findContact(toolInput.query);
      case 'list_contacts': return await listContacts(toolInput.category);
      default: return { error: 'Unknown contact tool: ' + toolName };
    }
  } catch (err) {
    console.error('Contact tool error:', err.message);
    return { error: err.message };
  }
}

module.exports = { contactsTools: contactsTools, handleContactTool: handleContactTool, resolveContact: resolveContact, isApprovedContact: isApprovedContact };
