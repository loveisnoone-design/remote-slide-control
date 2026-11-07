import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createSocket, type Socket } from 'node:dgram';
import { timingSafeEqual } from 'node:crypto';
import type { OperatorAction } from '@rsc/protocol';

/**
 * Local show control so Bitfocus Companion, a Stream Deck or a show controller
 * can drive slides without the web console:
 *
 *   HTTP  POST|GET /api/next  /api/back  /api/goto/4  /api/blank  /api/unblank
 *                  /api/lock  /api/unlock  /api/start  /api/timer/start|pause|reset
 *                  /api/timer/add/60   GET /api/state
 *   OSC   /next /back /goto <int> /blank [0|1] /lock [0|1] /start /timer/start …
 *         (an optional /rsc prefix is accepted)
 *
 * Bound to 127.0.0.1 unless "allow from the show network" is on, in which case
 * HTTP needs the token (header X-RSC-Token or ?token=).
 */

export interface ShowControlOptions {
  httpPort: number | null;
  oscPort: number | null;
  lan: boolean;
  token: string;
  run: (action: OperatorAction, source: string) => Promise<void>;
  state: () => unknown;
  log: (m: string) => void;
}

export function routeToAction(parts: string[], arg?: number): OperatorAction | null {
  const [a, b, c] = parts;
  switch (a) {
    case 'next':
      return { type: 'nav', op: 'next' };
    case 'back':
    case 'prev':
    case 'previous':
      return { type: 'nav', op: 'back' };
    case 'goto': {
      const n = Number(b ?? arg);
      return Number.isInteger(n) && n > 0 ? { type: 'nav', op: 'goto', slide: n } : null;
    }
    case 'blank':
      return { type: 'blank', on: arg === undefined ? true : arg !== 0 };
    case 'unblank':
      return { type: 'blank', on: false };
    case 'lock':
      return { type: 'lock', on: arg === undefined ? true : arg !== 0 };
    case 'unlock':
      return { type: 'lock', on: false };
    case 'start':
      return { type: 'start_show' };
    case 'timer':
      if (b === 'start' || b === 'pause' || b === 'reset') return { type: 'timer', action: b };
      if (b === 'add') {
        const s = Number(c ?? arg);
        return Number.isFinite(s) ? { type: 'timer', action: 'adjust', seconds: s } : null;
      }
      return null;
    default:
      return null;
  }
}

export class ShowControl {
  private http: Server | null = null;
  private osc: Socket | null = null;

  constructor(private readonly opts: ShowControlOptions) {}

  async start(): Promise<{ httpPort: number | null; oscPort: number | null }> {
    const host = this.opts.lan ? '0.0.0.0' : '127.0.0.1';
    let httpPort: number | null = null;
    let oscPort: number | null = null;
    if (this.opts.httpPort) {
      try {
        this.http = createServer((req, res) => void this.onHttp(req, res));
        await new Promise<void>((resolve, reject) => {
          this.http!.once('error', reject);
          this.http!.listen(this.opts.httpPort!, host, () => resolve());
        });
        httpPort = this.opts.httpPort;
      } catch (e) {
        this.opts.log(`HTTP show control could not start on ${this.opts.httpPort}: ${(e as Error).message}`);
        this.http = null;
      }
    }
    if (this.opts.oscPort) {
      try {
        this.osc = createSocket('udp4');
        this.osc.on('message', (buf) => this.onOsc(buf));
        await new Promise<void>((resolve, reject) => {
          this.osc!.once('error', reject);
          this.osc!.bind(this.opts.oscPort!, host, () => resolve());
        });
        oscPort = this.opts.oscPort;
      } catch (e) {
        this.opts.log(`OSC could not start on ${this.opts.oscPort}: ${(e as Error).message}`);
        this.osc = null;
      }
    }
    return { httpPort, oscPort };
  }

  stop(): void {
    this.http?.close();
    this.http = null;
    this.osc?.close();
    this.osc = null;
  }

  private authorised(req: IncomingMessage, url: URL): boolean {
    if (!this.opts.lan) return true;
    const given = (req.headers['x-rsc-token'] as string | undefined) ?? url.searchParams.get('token') ?? '';
    const want = this.opts.token;
    if (!want || given.length !== want.length) return false;
    return timingSafeEqual(Buffer.from(given), Buffer.from(want));
  }

  private async onHttp(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (!this.authorised(req, url)) return send(401, { ok: false, error: 'token required' });
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'api') return send(404, { ok: false, error: 'not found' });
    if (parts[1] === 'state' && req.method === 'GET') return send(200, this.opts.state());
    if (req.method !== 'POST' && req.method !== 'GET') return send(405, { ok: false });
    const action = routeToAction(parts.slice(1));
    if (!action) return send(404, { ok: false, error: 'unknown command' });
    try {
      await this.opts.run(action, 'HTTP');
      send(200, { ok: true });
    } catch (e) {
      send(500, { ok: false, error: (e as Error).message });
    }
  }

  private onOsc(buf: Buffer) {
    for (const m of parseOsc(buf)) {
      const parts = m.address.split('/').filter(Boolean);
      if (parts[0] === 'rsc') parts.shift();
      const first = m.args.find((x): x is number => typeof x === 'number');
      const action = routeToAction(parts, first);
      if (action) void this.opts.run(action, 'OSC').catch(() => undefined);
    }
  }
}

export interface OscMessage {
  address: string;
  args: Array<number | string | boolean>;
}

/** Minimal OSC 1.0 decoder: messages and bundles with i, f, s, T, F arguments. */
export function parseOsc(buf: Buffer): OscMessage[] {
  try {
    return parsePacket(buf, 0);
  } catch {
    return [];
  }
}

function parsePacket(buf: Buffer, depth: number): OscMessage[] {
  if (depth > 4 || buf.length < 4) return [];
  if (buf.subarray(0, 8).toString('ascii') === '#bundle\0') {
    const out: OscMessage[] = [];
    let off = 16; // "#bundle\0" + 8-byte time tag
    while (off + 4 <= buf.length) {
      const size = buf.readInt32BE(off);
      off += 4;
      if (size <= 0 || off + size > buf.length) break;
      out.push(...parsePacket(buf.subarray(off, off + size), depth + 1));
      off += size;
    }
    return out;
  }
  const [address, afterAddr] = readString(buf, 0);
  if (!address.startsWith('/')) return [];
  if (afterAddr >= buf.length) return [{ address, args: [] }];
  const [tags, afterTags] = readString(buf, afterAddr);
  if (!tags.startsWith(',')) return [{ address, args: [] }];
  let off = afterTags;
  const args: OscMessage['args'] = [];
  for (const t of tags.slice(1)) {
    if (t === 'i') {
      args.push(buf.readInt32BE(off));
      off += 4;
    } else if (t === 'f') {
      args.push(buf.readFloatBE(off));
      off += 4;
    } else if (t === 's') {
      const [s, next] = readString(buf, off);
      args.push(s);
      off = next;
    } else if (t === 'T') args.push(true);
    else if (t === 'F') args.push(false);
    else break;
  }
  return [{ address, args }];
}

function readString(buf: Buffer, off: number): [string, number] {
  const end = buf.indexOf(0, off);
  if (end < 0) throw new Error('unterminated OSC string');
  const s = buf.toString('utf8', off, end);
  return [s, off + Math.ceil((end - off + 1) / 4) * 4];
}
