/**
 * Command dispatcher: decodes/validates incoming envelopes, routes commands to
 * registered handlers, answers `request` commands with `response` events and
 * reports failures as `error` events.
 *
 * It is a handler registry: engine modules (and part 2 features) call
 * {@link Dispatcher.register} / {@link Dispatcher.registerRequest} without
 * editing this file. Commands without a handler produce a non-fatal
 * protocol `unsupported` error (requests get a failed `response`).
 *
 * Commands are processed strictly in arrival order; an async handler (e.g.
 * `init` fetching a world URL) delays the commands queued after it.
 *
 * @module
 */

import {
  decodeCommand,
  ENGINE_COMMAND_TYPES,
  type EngineCommand,
  type EngineCommandType,
  type EngineEvent,
  type RequestMethod,
  type RequestParamsMap,
  type RequestResultMap,
  type ResponseEvent,
} from '@diorama/protocol';

export type CommandOf<T extends EngineCommandType> = Extract<EngineCommand, { type: T }>;
export type CommandHandler<T extends EngineCommandType> = (command: CommandOf<T>) => void | Promise<void>;
export type RequestHandler<M extends RequestMethod> = (
  params: RequestParamsMap[M],
) => RequestResultMap[M] | Promise<RequestResultMap[M]>;

/** Error code for commands, requests and topics that have no handler (protocol `unsupported`). */
export const UNSUPPORTED = 'unsupported';

/**
 * @deprecated Engines before part 2 reported unhandled commands with this
 * code. The dispatcher now emits {@link UNSUPPORTED}; hosts should treat both
 * codes as "unsupported".
 */
export const NOT_IMPLEMENTED = 'NOT_IMPLEMENTED';

/** An error with a protocol error code; thrown by handlers to control the reported code. */
export class EngineError extends Error {
  constructor(readonly code: string, message: string, readonly fatal = false) {
    super(message);
    this.name = 'EngineError';
  }
}

const errorInfo = (e: unknown): { code: string; message: string; fatal: boolean } => {
  if (e instanceof EngineError) return { code: e.code, message: e.message, fatal: e.fatal };
  const code = typeof (e as { code?: unknown })?.code === 'string' ? (e as { code: string }).code : 'internal';
  return { code, message: e instanceof Error ? e.message : String(e), fatal: false };
};

export class Dispatcher {
  private handlers = new Map<string, (command: EngineCommand) => void | Promise<void>>();
  private requests = new Map<string, (params: unknown) => unknown>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly emit: (event: EngineEvent) => void) {}

  /** Registers (or replaces) the handler for a command type. `request` is routed internally; use {@link registerRequest}. */
  register<T extends Exclude<EngineCommandType, 'request'>>(type: T, handler: CommandHandler<T>): () => void {
    const fn = handler as (command: EngineCommand) => void | Promise<void>;
    this.handlers.set(type, fn);
    return () => { if (this.handlers.get(type) === fn) this.handlers.delete(type); };
  }

  /** Registers (or replaces) the handler for a request method. */
  registerRequest<M extends RequestMethod>(method: M, handler: RequestHandler<M>): () => void {
    const fn = handler as (params: unknown) => unknown;
    this.requests.set(method, fn);
    return () => { if (this.requests.get(method) === fn) this.requests.delete(method); };
  }

  /** True when a handler exists for the command type (or request method). */
  has(type: EngineCommandType | RequestMethod): boolean {
    return this.handlers.has(type) || this.requests.has(type);
  }

  /** Command types that currently have no handler (useful for diagnostics). */
  unimplemented(): EngineCommandType[] {
    return ENGINE_COMMAND_TYPES.filter((t) => t !== 'request' && !this.handlers.has(t));
  }

  /** Decodes an encoded command envelope and dispatches it. Invalid input emits `error` (`invalid_message`). */
  receive(raw: string): Promise<void> {
    const decoded = decodeCommand(raw);
    if (!decoded.ok) {
      this.emit({ type: 'error', code: 'invalid_message', message: decoded.error, fatal: false });
      // a request with a readable requestId still deserves a response
      const requestId = extractRequestId(raw);
      if (requestId) this.respondError(requestId, 'invalid_message', decoded.error);
      return this.queue;
    }
    return this.dispatch(decoded.value.msg);
  }

  /** Dispatches an already validated command; resolves when it (and everything queued before it) finished. */
  dispatch(command: EngineCommand): Promise<void> {
    const run = (): Promise<void> => this.run(command);
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  private async run(command: EngineCommand): Promise<void> {
    if (command.type === 'request') {
      const handler = this.requests.get(command.method);
      if (!handler) {
        this.respondError(command.requestId, UNSUPPORTED, `request method "${command.method}" is not implemented`);
        return;
      }
      try {
        const result = await handler(command.params);
        const ok = { type: 'response', requestId: command.requestId, ok: true, result } as ResponseEvent;
        this.emit(ok);
      } catch (e) {
        const info = errorInfo(e);
        this.respondError(command.requestId, info.code, info.message);
      }
      return;
    }
    const handler = this.handlers.get(command.type);
    if (!handler) {
      this.emit({ type: 'error', code: UNSUPPORTED, message: `command "${command.type}" is not implemented`, fatal: false });
      return;
    }
    try {
      await handler(command);
    } catch (e) {
      const info = errorInfo(e);
      this.emit({ type: 'error', code: info.code, message: `${command.type}: ${info.message}`, fatal: info.fatal });
    }
  }

  private respondError(requestId: string, code: string, message: string): void {
    this.emit({ type: 'response', requestId, ok: false, error: { code, message } });
  }
}

function extractRequestId(raw: string): string | null {
  try {
    const v = JSON.parse(raw) as { msg?: { type?: unknown; requestId?: unknown } };
    return v?.msg?.type === 'request' && typeof v.msg.requestId === 'string' && v.msg.requestId ? v.msg.requestId : null;
  } catch {
    return null;
  }
}
