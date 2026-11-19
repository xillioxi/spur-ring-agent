# Central Memory bank

Memory opens at `#memory`. The separate Social network workspace lives at
`#memory/social`; existing `#memory/whatsapp` links still open WhatsApp setup.

The bank organizes real records into About me, People, Projects and Knowledge.
It reads every saved email and WhatsApp account in the current business workspace,
without changing account selection, downloading media or requesting email bodies.
Email identities merge only on exact email addresses. WhatsApp identities remain
separate; matching names are not proof of the same person. Contact projections
are independent of the email visual graph's 300-node limit.

Observed contacts and project records are rebuilt from local sources, cached for
10 seconds. Address/domain relationship suggestions remain labelled. They are
not biographical facts or proof of friendship/employment. Full history coverage
depends on the individual provider's saved cache. Raw recent excerpts are shown
as observations; **Remember this** saves user-reviewed context with its source.

Saved notes and corrections persist in the workspace's
`memory-bank/memories.json`, using atomic private-file replacement. They have
optimistic versions, a 5,000-entry / 5 MiB limit, and retain source references.
Corrections here affect the central bank, not the original mailbox or WhatsApp
contact settings. There are no fictional sample memories or paid model calls.
Semantic automatic learning, screen capture, ring recordings, vector retrieval
and full-message knowledge extraction are not implemented by this change.

## API

- `GET /api/creator-agent/memory-bank/entries?query=&category=all&cursor=0&limit=40`
  returns entries, category counts, recent observations, source coverage, partial
  source warnings and `nextCursor`. Categories: `about`, `people`, `projects`,
  `knowledge`, `all`. Search happens before pagination.
- `POST /api/creator-agent/memory-bank/entries` accepts `category`, `title`,
  `content`, `version`, optional existing `id` and optional observed `sourceId`.
  An existing memory requires its latest version; new notes use version 0.

Browser writes require the existing local-origin boundary. The existing short
lived, workspace-scoped memory token permits **GET entries only**. The harness
has `memory_bank_search`; it cannot save memories or change connections.
Automatically projected business projects respect harness AI read permissions.
All source excerpts remain untrusted evidence, never instructions or permission.

## Checks

`node --test memory-bank/memory-bank.test.mjs email-memory/harness.test.mjs`
and `npm run build`. Loopback harness tests need local networking enabled.
