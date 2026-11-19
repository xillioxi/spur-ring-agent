const { resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

exports.inject = ['tools'];
exports.apply = async function (ctx) {
  const root = process.env.SPUR_REEL_WORKSPACE_ROOT;
  if (!root) throw new Error('Reel workspace must be configured by the host.');
  const { createReelTools } = await import(pathToFileURL(resolve(__dirname, '../../../web/reels/tools.mjs')).href);
  const service = createReelTools({ root, allowWrites: process.env.SPUR_REEL_ALLOW_WRITES === '1',
    allowRender: process.env.SPUR_REEL_ALLOW_RENDER === '1', ffmpegPath: process.env.SPUR_FFMPEG_PATH, ffprobePath: process.env.SPUR_FFPROBE_PATH });
  const output = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] };
  for (const descriptor of service.catalog().filter(item => item.enabled)) {
    ctx.tools.register({ name: descriptor.name, description: descriptor.description, parameters: descriptor.parameters, output,
      async execute(args) {
        try { return { ok: true, result: await service.execute(descriptor.name, args) }; }
        catch (error) { return { ok: false, error: { message: error.message } }; }
      } });
  }
};
