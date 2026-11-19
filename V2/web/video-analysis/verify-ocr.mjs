import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { recognizeFrameText } from './engine.mjs'

const workspaceRoot = fileURLToPath(new URL('../../../', import.meta.url))
const directory = path.join(workspaceRoot, 'V2/web/.runtime/video-analysis-tests')
const config = {
  SPUR_VIDEO_ANALYSIS_MODEL: process.env.SPUR_VIDEO_ANALYSIS_MODEL || 'qwen3-vl:2b-instruct',
  SPUR_VIDEO_ANALYSIS_OLLAMA_URL: process.env.SPUR_VIDEO_ANALYSIS_OLLAMA_URL || 'http://127.0.0.1:11435',
}
const started = Date.now()
const printed = await recognizeFrameText({ imageBase64: (await readFile(path.join(directory, 'scene-one.png'))).toString('base64'), timeSeconds: 0, config })
const nontext = await recognizeFrameText({ imageBase64: (await readFile(path.join(directory, 'sintel-nontext-12.jpg'))).toString('base64'), timeSeconds: 12, config })
const result = { method: 'independent_single_frame_transcription', elapsedSeconds: (Date.now() - started) / 1000, syntheticPrintedFrame: printed, actualSintelNontextFrame: nontext }
await writeFile(path.join(directory, 'independent-ocr-verification.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
assert.match(printed.onScreenText.join(' '), /SPUR RING/)
assert.match(printed.onScreenText.join(' '), /VIDEO SCRIPT TEST/)
assert.deepEqual(nontext.onScreenText, [], 'A frame without printed words must not become a generated scene caption.')
