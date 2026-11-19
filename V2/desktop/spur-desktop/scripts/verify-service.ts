import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { RingService } from '../electron/bridge';

const root = process.cwd();
const events: unknown[] = [];
const report: Record<string, unknown> = { authentication: false, touchReporting: false, audioCaptured: false, cloudUsed: false };
const service = new RingService(event => events.push(event), message => { report.serviceClosed = message; });
try {
  service.start(true, path.join(root, 'resources'), root, path.join(process.env.LOCALAPPDATA!, 'Spur', 'RingDesktop'));
  report.info = await service.request('getInfo');
  const devices = await service.request<{ id: string }[]>('scan');
  const address = process.argv[2];
  if (!devices.some(device => device.id.toUpperCase() === address?.toUpperCase())) throw new Error('The selected ring was not advertising during this scan.');
  await service.request('connect', { address }, 95000);
  report.authentication = true;
  await service.request('armDictation', {}, 15000);
  report.touchReporting = true;
  await service.request('disarmDictation', {}, 15000);
  report.disarmed = true;
} catch (error) { report.error = error instanceof Error ? error.message : String(error); }
finally {
  await service.close();
  report.events = events;
  await mkdir('test-output', { recursive: true });
  await writeFile('test-output/frozen-service-live.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
