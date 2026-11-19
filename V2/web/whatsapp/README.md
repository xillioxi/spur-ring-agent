# WhatsApp Memory

Open Memory → WhatsApp, or Connected Apps → WhatsApp. The local installation
offers two ingestion methods:

- QR companion-device linking via `@whiskeysockets/baileys` (unofficial, pinned).
  Start/reconnect explicitly; on the phone use WhatsApp → Linked devices → Link
  a device. Pairing expires after 150 seconds. Available history and incoming
  text/captions are saved. History completeness is never guaranteed.
- Import a phone-exported `.txt` chat (Android or iOS). Extract the text file if
  WhatsApp supplied a ZIP. Select DMY/MDY and the export timezone. Choose distinct
  conversation names for distinct accounts/chats. Reimport deduplicates identical
  sender/time/text entries. This is an import, not continuous synchronization.

Spur exposes no message sending or read-receipt action. A WhatsApp linked-device
session itself has broader account capabilities: users must explicitly review
the UI disclosure and approve the link on their phone. Unofficial clients can
break or cause account restrictions. The official Business Platform is a
different integration, not implemented here.

Messages are stored under `<business workspace>/whatsapp-memory/messages.json`;
email/WhatsApp and different WhatsApp accounts remain separate. Session credentials
are AES-GCM encrypted using a Windows DPAPI protected key. Other hosts use an
in-memory session. QR codes are transient, excluded from status, files and logs,
and are only served through the local pairing endpoint. No automatic connection
occurs on app launch. Reconnect resumes a saved session on supported hosts.

The 50,000-message per-source cap retains the newest text messages and reports
limited coverage. Each text is bounded to 64,000 characters; the JSON cache is
bounded to 100 MiB. Live ingestion excludes view-once/disappearing messages,
statuses and newsletter channels. Media files are not downloaded. Deletion
events remove their matching locally cached text when supplied by WhatsApp.
Editing messages is reflected when WhatsApp supplies a replay/upsert; dedicated
edit-event reconciliation is not implemented. Exports cannot reliably identify
the account owner's display name or disappearing-message status; they are saved
as explicitly imported records, not attributed to the linked phone account.

Chats can be assigned Friends, Family, Colleagues, Services, Companies or
Ungrouped, with an organization and responsibility. This first implementation
does not automatically infer relationships from group membership, merge phone
and email identities, or perform model analysis of private chats.

Private endpoints: `/api/creator-agent/whatsapp-memory`:

- GET `/status`, `/chats?query=&relationship=`, `/messages?accountId=&chatId=&query=&cursor=`
- GET `/pairing` (local UI only)
- POST `/connect`, `/pause`, `/account` (`accountId`), `/import`
- PATCH `/chats` (`accountId`, `chatId`, `relationship`, `company`, `role`)
- DELETE `/connection` removes session credentials and attempts device logout;
  saved messages remain. Verify removal in phone Linked devices if offline.

The existing scoped Memory harness plugin additionally exposes
`whatsapp_memory_status`, `whatsapp_memory_chats`, `whatsapp_memory_messages`.
It cannot pair, connect, import, change groups, send messages or read session keys.

Validation: `node --test whatsapp/whatsapp.test.mjs`. Optional live QR transport
check: `node whatsapp/qr-smoke.mjs` (no phone/account pairing or credentials saved).

References: [Baileys](https://github.com/WhiskeySockets/Baileys),
[WhatsApp export instructions](https://faq.whatsapp.com/1180414079177245/).

Live verification on this workstation: the Desktop/DARWIN descriptor caused
disconnect 428 before QR issuance. Switching to the Chrome descriptor resolved
QR generation in the unlinked live smoke check. The adapter now uses Chrome;
the regression test asserts this descriptor. Real phone pairing, supplied
history, live ingestion and session reconnection require a linked phone before
they can be verified end to end. Export import and simulated ingestion pass tests.
