import { apiRequest } from './taskApi'

export type VideoCapability = {
  available: boolean
  provider: string
  model: string
  durations: number[]
  resolutions: string[]
  ratios: string[]
  referenceImages: boolean
  watermark: string
  reason?: string
}

export type GeneratedVideo = {
  id: string
  status: 'submitting' | 'submission_unknown' | 'queued' | 'generating' | 'downloading' | 'completed' | 'failed' | 'paused'
  createdAt: string
  completedAt?: string
  prompt: string
  model: string
  duration: number
  resolution: string
  ratio: string
  seed?: number
  actualSeed?: number
  inference?: number
  images?: Array<{ url: string; role: 'first_frame' | 'last_frame' }>
  error?: string
  url?: string
}

export type VideoOverview = { capability: VideoCapability; jobs: GeneratedVideo[] }

export async function readVideoGeneration(): Promise<VideoOverview> {
  const data = (await apiRequest('/api/creator-agent/videos')).data
  if (data && !Array.isArray(data) && data.capability && Array.isArray(data.jobs)) return data
  // A running local backend may still be on the previous response shape until it restarts.
  return {
    capability: {
      available: false, provider: 'SiliconFlow', model: 'MiniMaxAI/MiniMax-H3',
      durations: Array.from({ length: 11 }, (_, index) => index + 5),
      resolutions: ['480p', '768p'], ratios: ['1:1', '3:4', '4:3', '9:16', '16:9', '21:9'],
      referenceImages: true, watermark: 'AI-generated watermark',
      reason: 'Restart the private agent service to enable the new H3 generation endpoint.',
    },
    jobs: Array.isArray(data) ? data : [],
  }
}

export async function generateVideo(input: {
  prompt: string
  duration: number
  resolution: string
  ratio: string
  seed?: number
  images?: GeneratedVideo['images']
}): Promise<GeneratedVideo> {
  return (await apiRequest('/api/creator-agent/videos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, requestKey: crypto.randomUUID() }),
  })).data
}

export async function resumeVideo(id: string): Promise<GeneratedVideo> {
  return (await apiRequest(`/api/creator-agent/videos/${id}/retry`, { method: 'POST' })).data
}
