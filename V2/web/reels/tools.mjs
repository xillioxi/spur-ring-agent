import { createReelWorkspace } from './workspace.mjs'

/** In-process interface for a host/harness. Host supplies root and permission grants. */
export function createReelTools({ root, allowWrites = false, allowRender = false, ffmpegPath, ffprobePath }) {
  const workspace = createReelWorkspace({ root, ffmpegPath, ffprobePath })
  const definitions = [
    ['reel_capabilities', 'Report real video analysis and render tool availability.', false, () => workspace.capabilities()],
    ['reel_references', 'List this workspace\'s reference videos and analysis provenance.', false, () => workspace.references()],
    ['reel_assets', 'List host-registered footage/music asset IDs and measured metadata without filesystem paths.', false, () => workspace.assets()],
    ['reel_reference', 'Retrieve all ordered, timed evidence for one reference. Input: {id}.', false, input => workspace.reference(input.id)],
    ['reel_search', 'Retrieve timed reference sections using compatible embeddings or explicit numeric features. Input: {embedding?,features?,limit?,referenceIds?}.', false, input => workspace.search(input)],
    ['reel_timing', 'Summarize measured timing and retain each reference sequence. Input: {referenceIds?}.', false, input => workspace.timing(input)],
    ['reel_plan', 'Apply a selected reference timing sequence to agent-selected footage. Input: {referenceId,shots:[{assetId,sourceStartSeconds}],music?,targetDurationSeconds?,canvas?}. Requires analyzed registered assets.', false, input => workspace.plan(input)],
    ['reel_analyze', 'Measure a registered local asset. Input: {assetId,referenceId?,source?:{url,title}}. Does not interpret scenes or produce embeddings.', true, input => workspace.analyze(input)],
    ['reel_import_reference', 'Store timestamped video observations and optional real embeddings with model/version provenance. Input: full reference record; see README schema.', true, input => workspace.importReference(input)],
    ['reel_render', 'Render a validated edit plan to a workspace MP4; no publishing. Input: {plan,outputFile}. Requires rendering grant.', true, input => workspace.render(input)],
  ]
  return {
    catalog: () => definitions.map(([name, description, write]) => ({ name, description,
      enabled: (!write || allowWrites) && (name !== 'reel_render' || allowRender),
      parameters: { type: 'object', properties: { input: { type: 'string', description: 'JSON-encoded input object. Use {} for no input.' } }, required: ['input'], additionalProperties: false } })),
    async execute(name, args) {
      const definition = definitions.find(item => item[0] === name)
      if (!definition) throw new Error('Unknown reel tool')
      if ((definition[2] && !allowWrites) || (name === 'reel_render' && !allowRender)) throw new Error('Host has not granted this reel operation')
      if (!args || Object.keys(args).some(key => key !== 'input') || typeof args.input !== 'string' || args.input.length > 8 * 1024 ** 2) throw new Error('Expected bounded JSON input string')
      const input = JSON.parse(args.input)
      if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Input must be an object')
      return definition[3](input)
    },
  }
}
