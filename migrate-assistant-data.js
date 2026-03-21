const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Rabih Assistant Supabase project
const SUPABASE_URL = 'https://ztkulifjzlurwthvjjlp.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

if (!SUPABASE_KEY) {
  console.error('ERROR: Set SUPABASE_SERVICE_KEY or SUPABASE_KEY env var first.');
  console.error('  Windows:  set SUPABASE_SERVICE_KEY=eyJ...');
  console.error('  Linux:    SUPABASE_SERVICE_KEY=eyJ... node migrate-assistant-data.js');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TABLES = [
  'assistant_messages',
  'rabih_memory',
  'contacts',
  'tasks',
  'scheduled_tasks',
  'pending_meetings',
  'invoices',
  'whatsapp_logs',
  'checklists',
  'checklist_responses',
  'usage_logs',
  'assistant_settings',
  'trade_alerts'
];

const OUT_DIR = path.join(__dirname, 'migration-export');

async function exportTable(name) {
  try {
    // Supabase default limit is 1000 — paginate to get all rows
    var allRows = [];
    var offset = 0;
    var pageSize = 1000;
    while (true) {
      var { data, error } = await supabase
        .from(name)
        .select('*')
        .range(offset, offset + pageSize - 1)
        .order('created_at', { ascending: true });

      if (error) {
        // Table might not exist — try without order (no created_at column)
        if (error.message && error.message.includes('created_at')) {
          var res = await supabase.from(name).select('*').range(offset, offset + pageSize - 1);
          if (res.error) throw res.error;
          data = res.data;
        } else {
          throw error;
        }
      }

      if (!data || data.length === 0) break;
      allRows = allRows.concat(data);
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    var filePath = path.join(OUT_DIR, name + '.json');
    fs.writeFileSync(filePath, JSON.stringify(allRows, null, 2));
    console.log('  ' + name + ': ' + allRows.length + ' rows -> ' + filePath);
    return allRows.length;
  } catch (err) {
    var msg = err.message || String(err);
    if (msg.includes('does not exist') || msg.includes('relation') || msg.includes('42P01')) {
      console.log('  ' + name + ': TABLE NOT FOUND (skipped)');
    } else {
      console.error('  ' + name + ': ERROR — ' + msg);
    }
    return 0;
  }
}

async function main() {
  console.log('Exporting from: ' + SUPABASE_URL);
  console.log('Output folder:  ' + OUT_DIR);
  console.log('');

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  var totalRows = 0;
  for (var table of TABLES) {
    totalRows += await exportTable(table);
  }

  console.log('');
  console.log('Done. Total rows exported: ' + totalRows);
}

main().catch(function(err) {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
