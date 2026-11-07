import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * One long-lived helper process that speaks JSON lines (the PowerShell bridge on
 * Windows). Requests are matched to responses by id; the process is restarted
 * on the next request if it dies.
 */
export class JsonLineBridge {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private readonly pending = new Map<string, Pending>();
  private stderr = '';

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly log: (msg: string) => void = () => {},
  ) {}

  private ensure(): ChildProcessWithoutNullStreams {
    if (this.proc && this.proc.exitCode === null && !this.proc.killed) return this.proc;
    const p = spawn(this.command, this.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdout.setEncoding('utf8');
    p.stderr.setEncoding('utf8');
    const rl = createInterface({ input: p.stdout });
    rl.on('line', (line) => this.onLine(line));
    p.stderr.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-4000);
    });
    p.on('exit', (code) => {
      this.log(`bridge exited (${code ?? 'signal'})${this.stderr ? `: ${this.stderr.trim().slice(-300)}` : ''}`);
      for (const [, w] of this.pending) {
        clearTimeout(w.timer);
        w.reject(new Error('Bridge process exited'));
      }
      this.pending.clear();
      if (this.proc === p) this.proc = null;
    });
    p.on('error', (err) => this.log(`bridge error: ${err.message}`));
    this.proc = p;
    return p;
  }

  private onLine(line: string) {
    const trimmed = line.trim().replace(/^﻿/, '');
    if (!trimmed.startsWith('{')) return;
    let msg: { id?: string; ok?: boolean; data?: unknown; error?: string };
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    const id = msg.id;
    if (!id) return;
    const w = this.pending.get(id);
    if (!w) return;
    this.pending.delete(id);
    clearTimeout(w.timer);
    if (msg.ok) w.resolve(msg.data ?? {});
    else w.reject(new Error(msg.error || 'Bridge request failed'));
  }

  request<T = Record<string, unknown>>(op: string, args: Record<string, unknown> = {}, timeoutMs = 5000): Promise<T> {
    const p = this.ensure();
    const id = String(++this.seq);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      p.stdin.write(`${JSON.stringify({ id, op, args })}\n`, 'utf8');
    });
  }

  dispose() {
    this.proc?.kill();
    this.proc = null;
  }
}

export function asArray<T>(v: T | T[] | null | undefined): T[] {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}
