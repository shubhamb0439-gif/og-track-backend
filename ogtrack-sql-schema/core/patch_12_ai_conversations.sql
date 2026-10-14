/* =============================================================================
   PATCH: ai_conversations / ai_conversation_messages — durable, multi-thread
   AIDA chat history for masteradmin (AIDA roadmap: cross-device continuity +
   "see my old chats" / "start a new chat")
   =============================================================================
   Run against OGCore itself (NOT a tenant database) — same convention as
   patch_02/03/05/11. Idempotent — safe to re-run.

   Context: src/aida/sessionMemory.js is a single in-memory, rolling 20-message
   window per admin, keyed by masteradmin:<adminId> — it already happens to be
   shared across web/Android/WhatsApp (they all resolve the same adminId), so
   a conversation DOES already continue across devices today, but only within
   a 2-hour TTL, with no durability across a server restart, and no concept of
   more than one thread at all — nothing to browse, nothing to "start fresh"
   from while keeping the old one around. This patch adds a real, durable,
   multi-conversation store (src/aida/conversationStore.js) underneath it;
   sessionMemory itself is untouched (still the fast in-process cache for an
   active request), this is the layer that makes continuity/history durable
   and browsable.
   ============================================================================= */

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_conversations')
BEGIN
    CREATE TABLE dbo.ai_conversations (
        id              NVARCHAR(64)    NOT NULL PRIMARY KEY,
        owner_id        NVARCHAR(64)    NOT NULL,   -- platform_admins.id
        title           NVARCHAR(200)   NULL,       -- auto-filled from the first user message once sent
        created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
        updated_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME(),
        last_message_at DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.ai_conversations') AND name = 'IX_ai_conversations_owner_last_message')
    CREATE INDEX IX_ai_conversations_owner_last_message ON dbo.ai_conversations (owner_id, last_message_at DESC);
GO

IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'ai_conversation_messages')
BEGIN
    CREATE TABLE dbo.ai_conversation_messages (
        id              NVARCHAR(64)    NOT NULL PRIMARY KEY,
        conversation_id NVARCHAR(64)    NOT NULL REFERENCES dbo.ai_conversations(id),
        role            NVARCHAR(20)    NOT NULL,   -- 'user' | 'assistant'
        content         NVARCHAR(MAX)   NOT NULL,
        created_at      DATETIME2       NOT NULL DEFAULT SYSUTCDATETIME()
    );
END
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID('dbo.ai_conversation_messages') AND name = 'IX_ai_conversation_messages_conv_created')
    CREATE INDEX IX_ai_conversation_messages_conv_created ON dbo.ai_conversation_messages (conversation_id, created_at ASC);
GO
