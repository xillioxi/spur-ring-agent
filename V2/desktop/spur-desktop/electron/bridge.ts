import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';
import { serviceLaunch } from './platform';

export class RingService {
  private child?: ChildProcessWithoutNullStreams;
  private sequence = 0;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  constructor(private event: (event: any) => void, private closed: (error: string) => void) {}
  start(packaged: boolean, resources: string, appRoot: string, dataDirectory: string): void {
    const { executable, args } = serviceLaunch(packaged, resources, appRoot, dataDirectory, process.platform, process.arch, process.env.SPUR_PYTHON);
    if (!existsSync(executable)) throw new Error('The ring service is missing. Re-extract the complete application folder.');
    this.child = spawn(executable, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      if (line.length > 2 * 1024 * 1024) { this.closed('The ring service sent an oversized response.'); return; }
      try {
        const value = JSON.parse(line);
        if (value.kind === 'event') this.event(value.event);
        else if (value.kind === 'result') {
          const pending = this.pending.get(value.id);
          if (pending) { clearTimeout(pending.timer); this.pending.delete(value.id); value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result); }
        }
      } catch { this.closed('The ring service sent an invalid response.'); }
    });
    // Python tracebacks stay out of user transcripts and never contain API credentials.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.fail('The ring service connection closed.'));
    this.child.on('error', () => this.fail('The native ring service could not start.'));
    this.child.on('exit', () => this.fail('The native ring service stopped. Restart Spur to reconnect.'));
  }
  private fail(message: string): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.pending.clear(); this.closed(message);
  }
  request<T = any>(method: string, params: Record<string, unknown> = {}, timeout = 30000): Promise<T> {
    if (!this.child || this.child.exitCode !== null || !this.child.stdin.writable) return Promise.reject(new Error('The ring service is unavailable.'));
    const id = String(++this.sequence);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The ${method} operation timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (error) { clearTimeout(timer); this.pending.delete(id); reject(new Error('The ring service connection closed.')); }
      });
    });
  }
  async close(): Promise<void> {
    if (!this.child) return;
    try { await this.request('shutdown', {}, 6000); } catch {}
    const child = this.child;
    child.stdin.end();
    if (child.exitCode === null) await new Promise<void>(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 15000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}
