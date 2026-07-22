/* =============================================================================
   TENANT DATABASE — Part 5: MESSAGING
   Provisioned when 'messages' module is enabled.

   Firestore modeled a conversation's memberIds as an array field and
   unreadCount as a map field, and messages as a sub-collection with a
   read[] array field. Relational SQL normalizes each of those into its
   own table (conversation_members, message_reads) rather than JSON blobs,
   since these need per-user querying ("all my conversations", "did X read
   this message") — a real join is both simpler and faster here than JSON
   array scans.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   conversations  (was: Firestore `conversations` collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.conversations (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    name              NVARCHAR(300)  NULL,                 -- empty for DMs, set for group chats
    type              NVARCHAR(10)   NOT NULL,              -- 'dm' | 'group'
    created_by        NVARCHAR(64)   NULL REFERENCES dbo.users(id),
    created_at        DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    last_message_at   DATETIME2      NULL,
    last_message      NVARCHAR(200)  NULL,                  -- truncated preview, matches old 60-char-slice behavior
    CONSTRAINT CK_conversations_type CHECK (type IN ('dm','group'))
);
GO

/* ---------------------------------------------------------------------------
   conversation_members  (replaces Firestore memberIds[] + unreadCount{} map)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.conversation_members (
    conversation_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.conversations(id) ON DELETE CASCADE,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    user_name         NVARCHAR(200)  NULL,
    unread_count      INT            NOT NULL DEFAULT 0,
    PRIMARY KEY (conversation_id, user_id)
);
GO
CREATE INDEX IX_conversation_members_user ON dbo.conversation_members(user_id);
GO

/* ---------------------------------------------------------------------------
   messages  (was: Firestore `conversations/{id}/messages` sub-collection)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.messages (
    id                NVARCHAR(64)   NOT NULL PRIMARY KEY,
    conversation_id   NVARCHAR(64)   NOT NULL REFERENCES dbo.conversations(id) ON DELETE CASCADE,
    sender_id         NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    sender_name       NVARCHAR(200)  NULL,
    text              NVARCHAR(MAX)  NOT NULL,   -- also carries the old '[img]'/'[video]'/'[file name=...]' markers
    sent_at           DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    reply_to          NVARCHAR(64)   NULL REFERENCES dbo.messages(id)
);
GO
CREATE INDEX IX_messages_conversation_sent ON dbo.messages(conversation_id, sent_at ASC);
GO

/* ---------------------------------------------------------------------------
   message_reads  (replaces Firestore per-message read[] array)
   --------------------------------------------------------------------------- */
CREATE TABLE dbo.message_reads (
    message_id        NVARCHAR(64)   NOT NULL REFERENCES dbo.messages(id) ON DELETE CASCADE,
    user_id           NVARCHAR(64)   NOT NULL REFERENCES dbo.users(id),
    read_at           DATETIME2      NOT NULL DEFAULT SYSUTCDATETIME(),
    PRIMARY KEY (message_id, user_id)
);
GO
