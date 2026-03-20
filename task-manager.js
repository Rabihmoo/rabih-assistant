const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function addTask(title, priority, dueDate, category) {
  var res = await supabase.from('tasks').insert({
    title: title,
    priority: priority || 'medium',
    due_date: dueDate || null,
    category: category || 'general',
    done: false
  });
  if (res.error) return { error: res.error.message };
  return { success: true, title: title, priority: priority || 'medium', due_date: dueDate || 'none' };
}

async function listTasks(filter) {
  var query = supabase.from('tasks').select('*').order('created_at', { ascending: false });
  if (filter === 'pending' || !filter) query = query.eq('done', false);
  if (filter === 'done') query = query.eq('done', true);
  if (filter === 'today') {
    var today = new Date().toISOString().split('T')[0];
    query = query.eq('done', false).eq('due_date', today);
  }
  if (filter === 'high') query = query.eq('done', false).eq('priority', 'high');
  var res = await query.limit(30);
  if (res.error) return { error: res.error.message };
  return {
    count: (res.data || []).length,
    tasks: (res.data || []).map(function(t) {
      return { id: t.id, title: t.title, priority: t.priority, due_date: t.due_date, category: t.category, done: t.done, created: t.created_at };
    })
  };
}

async function completeTask(titleKeyword) {
  var res = await supabase.from('tasks').select('id, title').eq('done', false).ilike('title', '%' + titleKeyword + '%').limit(5);
  if (res.error) return { error: res.error.message };
  if (!res.data || res.data.length === 0) return { error: 'No pending task found matching: ' + titleKeyword };
  var task = res.data[0];
  var upd = await supabase.from('tasks').update({ done: true }).eq('id', task.id);
  if (upd.error) return { error: upd.error.message };
  return { success: true, completed: task.title };
}

async function deleteTask(titleKeyword) {
  var res = await supabase.from('tasks').select('id, title').ilike('title', '%' + titleKeyword + '%').limit(5);
  if (res.error) return { error: res.error.message };
  if (!res.data || res.data.length === 0) return { error: 'No task found matching: ' + titleKeyword };
  var task = res.data[0];
  var del = await supabase.from('tasks').delete().eq('id', task.id);
  if (del.error) return { error: del.error.message };
  return { success: true, deleted: task.title };
}

async function getPendingTasksSummary() {
  var res = await supabase.from('tasks').select('title, priority, due_date, category').eq('done', false).order('priority').limit(20);
  if (res.error) return { error: res.error.message };
  return { count: (res.data || []).length, tasks: res.data || [] };
}

var taskTools = [
  {
    name: 'add_task',
    description: 'Add a task to Rabih\'s to-do list. Use when he says add task, remind me to do, I need to, put on my list.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Task description' },
        priority: { type: 'string', description: 'Priority: high, medium, low. Default medium.' },
        due_date: { type: 'string', description: 'Due date in YYYY-MM-DD format. Optional.' },
        category: { type: 'string', description: 'Category: work, personal, bbq_house, salt, cleaning, kitchen' }
      },
      required: ['title']
    }
  },
  {
    name: 'list_tasks',
    description: 'List tasks from Rabih\'s to-do list. Use when he asks what\'s on my list, my tasks, what do I need to do.',
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Filter: pending (default), done, today, high, all' }
      },
      required: []
    }
  },
  {
    name: 'complete_task',
    description: 'Mark a task as done. Use when Rabih says done, finished, completed, mark as done.',
    input_schema: {
      type: 'object',
      properties: {
        title_keyword: { type: 'string', description: 'Part of the task title to match' }
      },
      required: ['title_keyword']
    }
  },
  {
    name: 'delete_task',
    description: 'Delete a task from the list. Use when Rabih says remove task, delete task, cancel task.',
    input_schema: {
      type: 'object',
      properties: {
        title_keyword: { type: 'string', description: 'Part of the task title to match' }
      },
      required: ['title_keyword']
    }
  }
];

async function handleTaskTool(toolName, toolInput) {
  try {
    switch (toolName) {
      case 'add_task': return await addTask(toolInput.title, toolInput.priority, toolInput.due_date, toolInput.category);
      case 'list_tasks': return await listTasks(toolInput.filter);
      case 'complete_task': return await completeTask(toolInput.title_keyword);
      case 'delete_task': return await deleteTask(toolInput.title_keyword);
      default: return { error: 'Unknown task tool: ' + toolName };
    }
  } catch (err) {
    console.error('Task tool error:', err.message);
    return { error: err.message };
  }
}

module.exports = { taskTools: taskTools, handleTaskTool: handleTaskTool, getPendingTasksSummary: getPendingTasksSummary };
