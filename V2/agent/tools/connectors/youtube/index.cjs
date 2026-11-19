const { appendFileSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { channelDetails, myAnalytics, myChannel, myComments, searchVideos, videoDetails } = require('./client.cjs');
const { integrationToolVisible, assertIntegrationAccess } = require('../../business-workspace/access.cjs');

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

function summary(name, result) {
  if (!result || typeof result !== 'object') return undefined;
  if (name === 'youtube_search') {
    return { count: (result.videos || []).length, order: result.order, publishedWithinDays: result.publishedWithinDays, videoIds: (result.videos || []).map(video => video.videoId), cached: result.cached };
  }
  if (name === 'youtube_video') {
    return { count: (result.videos || []).length, videoIds: (result.videos || []).map(video => video.videoId), missing: result.missing, cached: result.cached };
  }
  if (name === 'youtube_my_channel') {
    return { channelId: result.channel?.channelId || null, title: result.channel?.title || null, videos: (result.videos || []).length, reason: result.reason, cached: result.cached };
  }
  if (name === 'youtube_my_comments') {
    return { channelId: result.channelId || null, count: (result.comments || []).length, reason: result.reason, cached: result.cached };
  }
  if (name === 'youtube_my_analytics') {
    return {
      range: result.range,
      summary: result.summary?.status,
      totals: result.summary?.rows?.[0] || null,
      daily: result.daily?.status,
      dailyRows: (result.daily?.rows || []).length,
      videos: result.videos?.status,
      videoRows: (result.videos?.rows || []).length,
      traffic: result.traffic?.status,
      retention: result.retention?.status,
      cached: result.cached,
    };
  }
  return { count: (result.channels || []).length, channelIds: (result.channels || []).map(channel => channel.channelId), cached: result.cached };
}

exports.inject = ['tools'];
exports.apply = function apply(ctx) {
  const root = process.env.SPUR_RESEARCH_OUTPUT;
  if (!root) throw new Error('Task output folder unavailable.');
  const cacheFile = join(root, 'youtube-cache.json');
  const log = event => appendFileSync(join(root, 'tool-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  const readCache = () => { try { return JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { return {}; } };
  const register = (name, description, parameters, execute) => {
    if (!integrationToolVisible('ai_read')) return;
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
        await assertIntegrationAccess('ai_read');
        const key = createHash('sha256').update(JSON.stringify({ name, args: stable(callArgs) })).digest('hex');
        const prior = readCache()[key];
        if (prior) {
          const replay = { ...prior, cached: true };
          log({ event: 'result', id, tool: name, available: true, summary: summary(name, replay) });
          return replay;
        }
        const result = await execute(callArgs);
        const store = readCache();
        store[key] = result;
        writeFileSync(cacheFile, JSON.stringify(store), { mode: 0o600 });
        log({ event: 'result', id, tool: name, available: true, summary: summary(name, result) });
        return result;
      } catch (error) {
        log({ event: 'result', id, tool: name, available: false, error: String(error.message) });
        throw error;
      }
    },
  });
  };

  register(
    'youtube_search',
    'Search public YouTube videos once. Use publishedWithinDays for a recent window, such as 30. When a window is set, results are ordered by viewCount unless another order is requested. Returns titles, publish times, channel names and video IDs, but not statistics. Call youtube_video for view, like and comment counts. Do not repeat an identical search in this task. Never invent growth, retention, CTR or revenue.',
    {
      query: { type: 'string', required: true },
      publishedWithinDays: { type: 'number' },
      maxResults: { type: 'number' },
      pageToken: { type: 'string' },
      order: { type: 'string', enum: ['viewCount', 'relevance', 'date'] },
    },
    args => searchVideos(args),
  );
  register(
    'youtube_video',
    'Read public details for up to 15 YouTube videos in one request. Pass video IDs or URLs from youtube_search. Returns title, publish time, views, likes, comments, duration and channel. A missing count means the API did not provide it; do not replace it with zero or an estimate.',
    { videos: { type: 'array', required: true, items: { type: 'string' } } },
    args => videoDetails(args),
  );
  register(
    'youtube_channel',
    'Read up to 8 public YouTube channels by channel ID, @handle, or channel URL. Returns subscriber, video and view totals when the API provides them. Use this to compare channels after reading their videos. Do not infer income or private analytics.',
    { channels: { type: 'array', required: true, items: { type: 'string' } } },
    args => channelDetails(args),
  );
  register(
    'youtube_my_channel',
    'Read the YouTube channel owned by the Google account that authorized Spur. Use this when the user asks for their own channel, account, or uploads and does not provide a channel ID or handle. Returns the channel name and ID plus the latest videos with title, publish time, views, likes and URL. If the account has no channel, say so. Do not ask the user for a handle first.',
    {},
    () => myChannel(),
  );
  register(
    'youtube_my_analytics',
    'Read YouTube Analytics for the authorized channel over the last 28 complete UTC days. Returns channel totals for views, estimatedMinutesWatched, averageViewDuration, subscribersGained and subscribersLost, plus separate daily, per-video and traffic-source reports. A zero row is real data. no_data means the API returned no rows. unsupported means that report combination is not available. Do not invent retention, revenue or CTR. averageViewDuration is seconds.',
    {},
    () => myAnalytics(),
  );
  register(
    'youtube_my_comments',
    'Read the newest comments on videos owned by the authorized YouTube channel. Returns at most 20 comments with video ID, public author name, time and the original text. This does not read comments on other channels. If comments are disabled or unavailable, say so and do not invent any comment.',
    {},
    () => myComments(),
  );
};
