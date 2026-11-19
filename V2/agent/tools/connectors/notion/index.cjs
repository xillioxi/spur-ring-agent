const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { appendBlocks, createPage, listPages, readPage, updateBlock } = require('./client.cjs');
const { integrationToolVisible, assertIntegrationAccess } = require('../../business-workspace/access.cjs');

const blockSchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['paragraph', 'heading_1', 'heading_2', 'heading_3', 'bulleted_list_item', 'numbered_list_item'] },
    text: { type: 'string' },
    url: { type: 'string' },
  },
  required: ['text'],
  additionalProperties: false,
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      if (value[key] !== undefined) result[key] = stable(value[key]);
      return result;
    }, {});
  }
  return typeof value === 'string' ? value.trim() : value;
}

function summary(result) {
  if (!result || typeof result !== 'object') return undefined;
  return {
    created: result.created,
    appended: result.appended,
    updated: result.updated,
    idempotent: result.idempotent,
    reason: result.reason,
    id: result.id,
    url: result.url,
    title: result.title,
    type: result.type,
    blockIds: Array.isArray(result.blocks) ? result.blocks.map(block => block.id) : undefined,
    texts: Array.isArray(result.blocks) ? result.blocks.map(block => block.text).filter(Boolean).slice(0, 20) : undefined,
    before: result.before,
    after: result.after,
  };
}

exports.inject = ['tools'];
exports.apply = function apply(ctx) {
  const root = process.env.SPUR_RESEARCH_OUTPUT;
  if (!root) throw new Error('Task output folder unavailable.');
  const log = event =>
    appendFileSync(
      join(root, 'tool-events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n',
    );
  const output = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  };
  const idempotencyFile = join(root, 'notion-idempotency.json');
  const readStore = () => {
    try { return JSON.parse(readFileSync(idempotencyFile, 'utf8')); } catch { return {}; }
  };
  const register = (name, description, parameters, execute, idempotent = false) => {
    const permission = idempotent ? 'ai_write' : 'ai_read';
    if (!integrationToolVisible(permission)) return;
    return ctx.tools.register({
      name,
      description,
      parameters,
      output,
      async execute(args) {
        const id = randomUUID();
        const callArgs = args || {};
        log({ event: 'call', id, tool: name });
        try {
          // Check current grants before either a cached result or a provider
          // request. Registration flags may be stale after a user revokes access.
          await assertIntegrationAccess(permission);
          const key = createHash('sha256').update(JSON.stringify({ name, args: stable(callArgs) })).digest('hex');
          if (idempotent) {
            const prior = readStore()[key];
            if (prior) {
              const replay = { ...prior, idempotent: true };
              log({ event: 'result', id, tool: name, available: true, summary: summary(replay) });
              return replay;
            }
          }
          const result = await execute(callArgs);
          if (idempotent && result && (result.created === true || result.appended === true || result.updated === true)) {
            const store = readStore();
            store[key] = result;
            writeFileSync(idempotencyFile, JSON.stringify(store), { mode: 0o600 });
          }
          log({ event: 'result', id, tool: name, available: true, summary: summary(result) });
          return result;
        } catch (error) {
          log({ event: 'result', id, tool: name, available: false, error: String(error.message) });
          throw error;
        }
      },
    });
  };

  register(
    'notion_list_pages',
    'List Notion pages already shared with the Spur integration. Use when the user refers to their notes, project material, or Notion. Returns titles and page IDs only. Does not modify Notion.',
    { query: { type: 'string' } },
    async ({ query } = {}) => {
      const text = typeof query === 'string' ? query.trim().slice(0, 200) : '';
      return { pages: await listPages(text) };
    },
  );
  register(
    'notion_read_page',
    'Read one shared Notion page, including its title, plain-text body, and top-level blocks with their block IDs. Pass a page ID or URL. Use a returned block ID for notion_update_block. Cite the page title and URL. Does not modify Notion.',
    { page: { type: 'string', required: true } },
    async ({ page } = {}) => readPage(page),
  );
  register(
    'notion_create_page',
    'Create a child page under one shared Notion page. parent is a page ID, URL, or exact title. If the parent is missing or ambiguous, return candidates and do not write. title is the new page title. blocks is an optional array of paragraph, heading, or list items. An identical call in this same task returns the first result and does not create another page. A later task may create another page with the same title. Do not delete or replace existing pages.',
    {
      parent: { type: 'string', required: true },
      title: { type: 'string', required: true },
      blocks: { type: 'array', items: blockSchema },
    },
    args => createPage(args),
    true,
  );
  register(
    'notion_append_blocks',
    'Append paragraph, heading, or list blocks to the end of one shared Notion page. page is a page ID or URL from a previous Notion tool result. Returns the new block IDs. An identical call in this same task returns the first result. A later task may append the same text again. Do not use this to imitate an edit.',
    {
      page: { type: 'string', required: true },
      blocks: { type: 'array', required: true, items: blockSchema },
    },
    args => appendBlocks(args),
    true,
  );
  register(
    'notion_update_block',
    'Replace the text of one existing paragraph, heading, or list block. block must be the exact block ID returned by notion_read_page or notion_append_blocks. Never choose a block by similar text. The block type stays unchanged. Returns the text before and after the update.',
    {
      block: { type: 'string', required: true },
      text: { type: 'string', required: true },
    },
    args => updateBlock(args),
    true,
  );
};
