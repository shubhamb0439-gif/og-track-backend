const express = require('express');
const router = express.Router();

// ── Helpers ──────────────────────────────────────────────────────────────────
const dTime = (v) => {          // DATETIME2 → ISO string (fixes "Invalid Date")
  if (v == null) return null;
  return (v instanceof Date) ? v.toISOString() : new Date(v).toISOString();
};

// Conversation → shape the old frontend expects (camelCase + member/unread maps).
async function mapConversation(db, convo) {
  const members = await db('conversation_members').where({ conversation_id: convo.id });
  const memberIds = members.map(m => m.user_id);
  const memberNames = members.map(m => m.user_name);
  const unreadCount = {};
  members.forEach(m => { unreadCount[m.user_id] = m.unread_count; });
  return {
    id: convo.id,
    name: convo.name,
    type: convo.type,
    createdBy: convo.created_by,
    createdAt: dTime(convo.created_at),
    lastMessage: convo.last_message,
    lastMessageAt: dTime(convo.last_message_at),
    memberIds, memberNames, unreadCount,
  };
}

// Message row → frontend shape. `replyObj` is the rehydrated {id,senderName,text}.
const mapMessage = (m, read, replyObj) => ({
  id: m.id,
  conversationId: m.conversation_id,
  senderId: m.sender_id,
  senderName: m.sender_name,
  text: m.text,
  sentAt: dTime(m.sent_at),
  replyTo: replyObj || null,
  read: read || [],
});

// GET /api/:slug/conversations/:userId — all conversations for a user
router.get('/:userId', async (req, res) => {
  try {
    const memberRows = await req.db('conversation_members').where({ user_id: req.params.userId });
    const convoIds = memberRows.map(m => m.conversation_id);
    if (!convoIds.length) return res.json([]);
    const convos = await req.db('conversations').whereIn('id', convoIds).orderBy('last_message_at', 'desc');
    const mapped = await Promise.all(convos.map(c => mapConversation(req.db, c)));
    res.json(mapped);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/conversations — create DM or group
router.post('/', async (req, res) => {
  try {
    const { name, memberIds, memberNames, type, createdBy } = req.body;

    // For DMs, reuse an existing 1:1 conversation between the same two members.
    if (type === 'dm' && memberIds.length === 2) {
      const aRows = await req.db('conversation_members').where({ user_id: memberIds[0] });
      for (const row of aRows) {
        const members = await req.db('conversation_members').where({ conversation_id: row.conversation_id });
        const convo = await req.db('conversations').where({ id: row.conversation_id, type: 'dm' }).first();
        if (convo && members.length === 2 && members.some(m => m.user_id === memberIds[1])) {
          return res.json(await mapConversation(req.db, convo));
        }
      }
    }

    const id = 'c' + Date.now();
    const now = new Date();
    await req.db('conversations').insert({
      id, name: name || '', type, created_by: createdBy || null,
      created_at: now, last_message_at: now, last_message: '',
    });
    for (let i = 0; i < memberIds.length; i++) {
      await req.db('conversation_members').insert({
        conversation_id: id, user_id: memberIds[i], user_name: memberNames[i] || null, unread_count: 0,
      });
    }
    const saved = await mapConversation(req.db, await req.db('conversations').where({ id }).first());
    memberIds.forEach(mid => req.io.to(req.company.slug).emit(`conversation:new:${mid}`, saved));
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /api/:slug/conversations/:id/messages
router.get('/:id/messages', async (req, res) => {
  try {
    const rows = await req.db('messages').where({ conversation_id: req.params.id }).orderBy('sent_at', 'asc').limit(100);

    // Batch-rehydrate reply targets (reply_to stores a message id; the UI wants
    // an object with senderName+text).
    const replyIds = [...new Set(rows.map(m => m.reply_to).filter(Boolean))];
    const replyMap = {};
    if (replyIds.length) {
      const refs = await req.db('messages').whereIn('id', replyIds).select('id', 'sender_name', 'text');
      refs.forEach(r => { replyMap[r.id] = { id: r.id, senderName: r.sender_name, text: r.text }; });
    }

    const out = [];
    for (const m of rows) {
      const reads = await req.db('message_reads').where({ message_id: m.id }).select('user_id');
      out.push(mapMessage(m, reads.map(r => r.user_id), m.reply_to ? replyMap[m.reply_to] : null));
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/:slug/conversations/:id/messages — send a message
router.post('/:id/messages', async (req, res) => {
  try {
    const { senderId, senderName, text, replyTo } = req.body;
    const convoId = req.params.id;
    const id = 'm' + Date.now();
    const now = new Date();
    // replyTo arrives as {id,senderName,text}; persist only the id (scalar FK).
    const replyToId = (replyTo && replyTo.id) || null;
    await req.db('messages').insert({
      id, conversation_id: convoId, sender_id: senderId, sender_name: senderName,
      text, sent_at: now, reply_to: replyToId,
    });

    // Bump unread counts for everyone except the sender.
    const members = await req.db('conversation_members').where({ conversation_id: convoId });
    for (const m of members) {
      if (m.user_id !== senderId) {
        await req.db('conversation_members')
          .where({ conversation_id: convoId, user_id: m.user_id })
          .increment('unread_count', 1);
      }
    }

    // Preview text (mirror old [img]/[video]/[file] handling).
    let preview = text;
    if (text.startsWith('[img]')) preview = '📷 Photo';
    else if (text.startsWith('[video]')) preview = '🎬 Video';
    else if (/^\[file name=/.test(text)) preview = '📎 File';
    if (preview.length > 60) preview = preview.slice(0, 60) + '...';
    await req.db('conversations').where({ id: convoId }).update({ last_message: preview, last_message_at: now });

    // Echo back in camelCase; reuse the replyTo object the client already sent.
    const saved = mapMessage(
      { id, conversation_id: convoId, sender_id: senderId, sender_name: senderName, text, sent_at: now, reply_to: replyToId },
      [],
      replyTo || null
    );
    members.forEach(m => req.io.to(req.company.slug).emit(`message:new:${m.user_id}`, { convoId, message: saved }));
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/:slug/conversations/:id/read — mark read for a user
router.patch('/:id/read', async (req, res) => {
  try {
    const { userId } = req.body;
    const convoId = req.params.id;
    await req.db('conversation_members').where({ conversation_id: convoId, user_id: userId }).update({ unread_count: 0 });

    const msgs = await req.db('messages').where({ conversation_id: convoId }).whereNot({ sender_id: userId });
    for (const m of msgs) {
      const exists = await req.db('message_reads').where({ message_id: m.id, user_id: userId }).first();
      if (!exists) await req.db('message_reads').insert({ message_id: m.id, user_id: userId, read_at: new Date() });
    }

    const members = await req.db('conversation_members').where({ conversation_id: convoId });
    members.forEach(m => {
      if (m.user_id !== userId) req.io.to(req.company.slug).emit(`seen:${m.user_id}`, { convoId, seenBy: userId });
    });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;