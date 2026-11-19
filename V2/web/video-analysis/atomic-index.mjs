import { rename } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'

// Windows scanners can briefly hold a freshly read index open. Keep the atomic
// replacement and retry the sharing violation; never delete the original file.
export async function replaceIndex(temporary, destination) {
  const waits = [15, 40, 90, 180, 300]
  for (let attempt = 0;; attempt++) {
    try { return await rename(temporary, destination) }
    catch (cause) {
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(cause.code) || attempt >= waits.length) throw cause
      await delay(waits[attempt])
    }
  }
}
