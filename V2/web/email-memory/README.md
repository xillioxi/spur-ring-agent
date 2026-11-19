# Memory → Email network

The default directory uses Friends, Family, Colleagues, Services, Companies and
Other contacts, with collapsible organizations nested inside relationship groups.
Contact rows show the person, responsibility, context and message count. Select
a contact to review or correct their details; focus an organization or search to
open its people. The visual graph is optional and loads only when opened.
Large graphs show organization summaries; email activity can be shown separately
in detailed views.
Relationship filters apply before the 300-node limit, and counts cover every
matching saved contact, including contacts outside the current drawing.

Grouping suggestions use sender mailbox labels, service addresses and email
domains. An organization domain is a hint, not verified employment. Common email
subdomains are grouped using a small compound-domain suffix list (not a complete
public suffix registry). Friends and Family need a matching mailbox label or a
saved correction. Roles come from service aliases or explicit first-person
responsibility statements in saved sender snippets. Unknown roles stay unknown;
this is local evidence-based grouping, not a semantic LLM analysis of full emails.

Select a person to review evidence and save their group, organization and role.
`PATCH /api/creator-agent/email-memory/contacts` accepts `email`, the expected
`accountId`, `relationship` (`auto`, `friends`, `family`, `colleagues`, `services`,
`company`, `other`), `company` (120 characters) and `role` (200 characters).
Corrections live in that mailbox's private cache and survive synchronization.
The read-only harness graph exposes context and evidence; its token cannot write
contact corrections. GET `/graph` accepts `query` and `relationship`.

Open `http://127.0.0.1:5174/#memory`, choose **Add mailbox**, then **Sync all
mail**. Connections also links here. The default Memory view uses real saved
mailbox data. Fictional content remains under **Illustrative examples** and never
populates the live network.

## Connection

Choose Gmail, Outlook / Microsoft 365, Zoho, or Other IMAP in the connection form.
The top bar follows Video → Inverse prompting's account workspace pattern: add
several mailboxes, keep them connected and switch the selected mailbox. The Add
mailbox popup has a provider dropdown; multiple accounts can use the same provider.
Each mailbox has its own network, email library, connection and sync checkpoint.
Switching the view does not disconnect other accounts or redirect an existing
sync onto another mailbox. Saved caches and credentials remain separate.

**Sign in with Google** is the primary Gmail connection. Each mailbox owner
chooses their Google account and approves read-only Gmail access. Users do not
need to register a Google Cloud application for each account. App registration is
a one-time responsibility of the Spur installation owner, as it is in the older
[`spur-ring-agent` Google integration](https://github.com/xillioxi/spur-ring-agent/blob/main/spur/office.py).

The host uses a complete `GMAIL_CLIENT_ID` / `GMAIL_CLIENT_SECRET` pair, then a
complete `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` pair, then a complete
`YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` pair. Partial pairs are never mixed.
Reuse the existing Spur Google Cloud project and Web application OAuth client
where available; a new app registration is not inherently required. Enable the
Gmail API and configure the Google consent screen/test users. Add this redirect
to the existing client's authorized redirect URIs:
`http://127.0.0.1:4173/api/email-memory/oauth/callback`. The new grant requests only
`https://www.googleapis.com/auth/gmail.readonly`, with PKCE and a ten-minute,
one-use workspace-bound state. Google distribution/restricted-scope review still
applies; this is a local integration, not a production multi-user OAuth service.

The current Node host loads `SPUR_CONFIG_FILE` or
`V2/agent/config/siliconflow.env`, followed by its process environment. Save the
existing client configuration server-side and restart the host. Do not put a
client secret in a Vite variable, browser storage, chat or source control.
Registration settings in the older Python app's `office_apps` table are not
automatically loaded by this host. Its Google account sign-in and provider
refresh tokens are also not interchangeable with this connector. The source
repository includes the implementation, not live registration credentials.
Connecting Gmail in ChatGPT grants access to ChatGPT's connection; Spur needs
its own user authorization. Gmail access also requires Gmail scopes, beyond
ordinary identity sign-in. Existing YouTube tokens are never reused.

On Windows, an installation owner can also import a downloaded Google **Web
application** client JSON without copying its secret into an environment file:

```powershell
node google-oauth-client.mjs import 'C:\path\to\downloaded-google-client.json' '.runtime'
```

Run this from `V2/web`, then restart the host. The importer requires the exact
callback above and Google's own authorization/token endpoints. App client
credentials are saved using Windows CurrentUser DPAPI under
`.runtime/google-oauth-client`, separately from each mailbox's refresh tokens.
Successful output contains setup metadata only. A complete explicit host
environment client pair takes precedence over the imported registration.
Non-Windows hosts should use the existing server environment setup unless an
OS-protected store is provided. This owner setup does not authorize any mailbox;
the user still completes Google's account choice and Gmail consent.

An unconfigured installation keeps Google sign-in visible but unavailable and
identifies this as installation setup, rather than requiring every user to
create an app. **Use an app password instead** is a collapsed, optional fallback
for a Gmail address and a [Google app password](https://support.google.com/accounts/answer/185833).
Enter it only in Spur's connection form, never in chat. Google requires 2-Step
Verification and does not offer app passwords for every account/organization.

### Outlook and Microsoft 365

Microsoft requires [modern authentication](https://support.microsoft.com/en-gb/outlook/pop-imap-and-smtp-settings-for-outlook-com).
Choose Outlook and **Sign in with Microsoft**. This provider uses Microsoft Graph
with delegated `Mail.Read`, `User.Read` and `offline_access`; there is no send/write
scope or password-based Outlook fallback. Personal Outlook.com and Microsoft 365
accounts can sign in, subject to their organization's consent policy.

The Spur host needs `OUTLOOK_CLIENT_ID` or `MICROSOFT_CLIENT_ID`, and optionally the
matching client secret for a confidential app. Alternatively, enter your own
public desktop application's ID in the form. The app must be registered for the
desired Microsoft account types and the fixed loopback redirect
`http://127.0.0.1:4173/api/email-memory/outlook/callback`. See Microsoft's
[app registration guide](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app).
Tokens stay private; PKCE and one-use state bind the callback to its workspace.
An unconfigured host does not provide one-click Microsoft sign-in until an app ID
has been supplied. No third-party application's client ID is borrowed.

### Zoho and other IMAP providers

Zoho uses its [official IMAP settings](https://www.zoho.com/mail/help/imap-access.html)
and regional presets from its [data-centre table](https://www.zoho.com/mail/help/adminconsole/autodiscovery-settings.html).
Choose the matching account type and region, enable IMAP in Zoho, and enter an
application-specific password when two-factor authentication or account policy
requires one. The Zoho plan must include IMAP access. Remaining data centres can
use the Other IMAP option with the hostname from their own account settings.

Other IMAP takes an email address, password/application password and public mail
server hostname. It requires verified TLS on port 993. All DNS answers are checked
and the connection pins that approved address set while retaining hostname/SNI
certificate validation. IP literals, private/local destinations, arbitrary ports
and insecure certificate/SSL options are not accepted. Providers which require
OAuth instead of password authentication need a corresponding OAuth connection;
the generic password form cannot override their policy.

### Zoho connection troubleshooting

The form displays the exact incoming server for the selected region and account
type. Auto suggests personal settings for Zoho-branded addresses and organization
settings for custom domains; this does not determine the account's plan. Personal
and free-organization accounts can use different server settings from paid
organizations, so the mailbox's own Zoho Server Configuration Details take
precedence. Region selection is never inferred from the computer's location.

Spur now retains safe, specific failure codes for sign-in rejection, an explicit
app-password requirement, disabled IMAP, account restrictions, rate limits,
region mismatches, DNS failures, TLS certificate errors and timeouts. Messages
are selected from fixed guidance; raw IMAP responses, credentials and login
transcripts are never returned. Unknown exceptions still get a generic message.
An earlier generic failure cannot be diagnosed retroactively because unsuccessful
credentials and raw login transcripts were not saved. A retry uses the new error
classification without trying other data centres or sending multiple automatic
credential attempts.

On 2026-11-17, credential-free checks reached verified TLS and an OK IMAP greeting
on both US endpoints (`imappro.zoho.com:993` and `imap.zoho.com:993`). This verifies
transport only, not a user's password, subscription, IMAP permission or region.

## Data and graph

- Gmail sync follows All Mail, including sent/archived mail, excluding Spam/Trash.
  Outlook and other providers scan their available mail folders with excluded
  system folders disclosed in the connection scope; saved metadata retains its
  source provider and mailbox identity.
- Search indexed names, addresses, subjects and available snippets; paginate all
  saved messages. Full message text loads only when opened and is not persisted.
- Select a person to open their source emails. Directed edges mean actual
  sender-to-recipient evidence, weighted by distinct messages. Co-recipients are
  not automatically friends. Unsent drafts stay searchable but establish no
  communication edges or contact counts.
- Display up to 300 graph nodes and 3,000 strongest visible edges, with explicit
  coverage. Contact search occurs before display limits. Email browsing is not
  restricted to the visible graph.
- No automatic biography, relationship inference or LLM mailbox upload is used
  to build the graph.

Each successful page saves a private, account-bound checkpoint. Long batches
continue automatically until real feed end, provider failure or a safety limit.
Rate limits, expired access, interrupted scans and invalid cursors remain visibly
incomplete. Resume continues valid checkpoints; fresh sync restarts enumeration.
Only a complete successful refresh reconciles source deletions.

The workspace is bounded at 100,000 metadata entries and 100 MiB. Reaching a bound
is partial, never “all mail synced.” Accounts have separate hashed cache files.
Disconnecting retains saved headers locally and requires reconnecting the same
account to load original message text.

IMAP selects an inline text MIME part with a 1 MiB transfer/64,000-character
preview bound; no attachment part or full message source is fetched. API previews
are bounded too, but Google's full-message response can include small inline
nontext parts before filtering. Attachments are never indexed, saved or exposed.
HTML is converted to text, never rendered, and remote images are
not fetched. Oversized previews are labelled truncated.

## Privacy and authorization

Credentials use Windows CurrentUser DPAPI; other platforms use session memory.
They are not returned by status, placed in URLs/browser storage, written to
message metadata or passed to the Harness. The form clears its password after
attempts/cancellation. Metadata files use private file modes; this is not a claim
that every cached email header is encrypted at rest.

Gmail IMAP is fixed to `imap.gmail.com:993`. Zoho uses verified regional settings;
Other IMAP uses its validated public hostname. Connections verify TLS, open
folders read-only and use BODY.PEEK. There is no send/delete/flag operation. App passwords themselves
are not provider-enforced read-only grants; Google OAuth supplies that scope.

The host's workspace and same-origin checks protect the private API. Email and
credentials stay local even if chat uses the cloud bridge. Public guest routes
are not expanded. OAuth completion uses its separate validated state.

## API and Harness

Prefix: `/api/creator-agent/email-memory`.

| Route | Behavior |
| --- | --- |
| GET `/status` | Connection, sync progress/bounds; no token or provider cursor |
| POST `/connect` | Verify provider/email/appPassword and optional IMAP settings |
| POST `/oauth/start` | Return Google or Microsoft authorization URL |
| DELETE `/connection` | Disconnect; preserve saved metadata |
| POST `/mailboxes/select` | Select `{mailboxId}` without disconnecting other accounts |
| POST `/sync` | Async `{resume?:boolean}`, returns 202 |
| GET `/graph?query=...` | Network and display coverage |
| GET `/messages?person=...&query=...&cursor=...&limit=...` | Search and browse metadata |
| GET `/messages/:id` | Bounded plain-text source message |

Native tools `email_memory_status`, `email_memory_search`, `email_memory_message`
and `email_memory_network` use a short-lived, workspace-scoped read token. They
are registered only when the existing integration AI-read permission allows it.
They read the selected mailbox and cannot connect, select, sync, disconnect, send or change mail. A requested agent
task can read selected email evidence; graph construction itself uses no LLM.
Live tools still need the separately configured Harness runtime.

## Open-source components

| Component | Purpose | License |
| --- | --- | --- |
| [Cytoscape.js](https://github.com/cytoscape/cytoscape.js) | Lazy interactive graph renderer | MIT |
| [ImapFlow](https://github.com/postalsys/imapflow) | Gmail IMAP protocol | MIT |
| [MailParser](https://github.com/nodemailer/mailparser) | Header/MIME decoding and text conversion | MIT |

Other renderer options are [Sigma.js](https://github.com/jacomyal/sigma.js) with
Graphology and [React Force Graph](https://github.com/vasturiano/react-force-graph).
Spur supplies authorization, indexing, relationship semantics and source browsing.

## Verification

The centered Add mailbox popup and Zoho diagnostic update passed 94 focused
tests and the production build. Browser checks verified provider focus, Tab
containment, Escape closing, focus restoration, background inertness, and the
Zoho failure flow using synthetic credentials only. The failure remained inside
the popup, cleared its password and retained the email/settings. The real app
was left with the popup ready; no pasted credentials were used or recorded in
test scripts or evidence. This does not verify a real Zoho account's sign-in.

The multi-mailbox/provider update passed 82 focused tests and the production
build. Browser verification used three isolated synthetic accounts: Gmail with
20 messages, Outlook with 40 and Zoho with 60. Each showed different contacts;
switching back restored the correct saved library and all three accounts remained
connected. Add mailbox retained its provider dropdown while another mailbox was
selected. The real owner workspace remains unconnected; no real Outlook, Zoho or
other mailbox was accessed. The synthetic server was stopped. New proof files use
the `email-memory-multi-*` prefix under the ignored `.runtime/verification`.

On 2026-11-17, 42 focused provider/storage/graph/API/UI tests and four local bridge
boundary checks passed; TypeScript and the production build passed. An isolated
browser fixture imported 60 synthetic messages across three pages, rendered four
contacts, paginated 50→60 messages, filtered a contact's 18 messages, searched the
full cache and displayed malicious markup as literal text. The fixture was
stopped and was never mixed into the real owner workspace. Windows DPAPI
protection/reopening/clearing passed using a synthetic credential. The real
mailbox is unconnected; live Gmail authorization and reading require the user's
connection. Evidence and screenshots are under the ignored `.runtime/verification`.
