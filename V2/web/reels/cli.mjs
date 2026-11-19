import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createReelWorkspace } from './workspace.mjs'
import { getMediaCapabilities } from './media.mjs'

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv
  const options = {}
  for (let index = 0; index < rest.length; index += 2) {
    if (!/^--[a-z-]+$/.test(rest[index]) || !rest[index + 1] || rest[index + 1].startsWith('--')) throw new Error('Options must be --name value pairs')
    if (Object.hasOwn(options, rest[index])) throw new Error('Repeated option')
    options[rest[index]] = rest[index + 1]
  }
  const allowed = {
    capabilities: [], assets: ['--workspace'], references: ['--workspace'], reference: ['--workspace', '--id'],
    analyze: ['--workspace', '--asset', '--reference', '--url', '--title'],
    import: ['--workspace', '--input'], search: ['--workspace', '--input'],
    timing: ['--workspace', '--input'], plan: ['--workspace', '--input', '--out'],
    render: ['--workspace', '--input', '--out'],
  }
  if (!Object.hasOwn(allowed, command)) throw new Error('Commands: capabilities, assets, analyze, import, references, reference, search, timing, plan, render. See reels/README.md.')
  for (const key of Object.keys(options)) if (!allowed[command].includes(key)) throw new Error(`Unknown option ${key}`)
  const binaries = { ffmpegPath: process.env.SPUR_FFMPEG_PATH, ffprobePath: process.env.SPUR_FFPROBE_PATH }
  if (command === 'capabilities') return getMediaCapabilities(binaries)
  if (!options['--workspace']) throw new Error('--workspace is required')
  const workspace = createReelWorkspace({ root: path.resolve(options['--workspace']), ...binaries })
  const input = async () => { if (!options['--input']) throw new Error('--input is required'); return workspace.readWorkspaceJson(options['--input']) }
  if (command === 'assets') return workspace.assets()
  if (command === 'references') return workspace.references()
  if (command === 'reference') return workspace.reference(options['--id'])
  if (command === 'analyze') return workspace.analyze({ assetId: options['--asset'], referenceId: options['--reference'],
    ...(options['--reference'] ? { source: { url: options['--url'], title: options['--title'] } } : {}) })
  if (command === 'import') return workspace.importReference(await input())
  if (command === 'search') return workspace.search(await input())
  if (command === 'timing') return workspace.timing(options['--input'] ? await input() : undefined)
  if (command === 'render') return workspace.render({ plan: await input(), outputFile: options['--out'] })
  const plan = await workspace.plan(await input())
  if (options['--out']) await workspace.writeWorkspaceJson(options['--out'], plan)
  return plan
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(result => process.stdout.write(JSON.stringify({ ok: true, result }, null, 2) + '\n'))
    .catch(error => { process.stderr.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1 })
}
