import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import type { z } from 'zod';

export class HttpProblem extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export function parseBody<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    throw new HttpProblem(
      400,
      'validation_error',
      'Invalid request',
      r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return r.data;
}

export function notFound(what = 'Resource'): never {
  throw new HttpProblem(404, 'not_found', `${what} not found`);
}

/** Only allow opaque ids (cuid-like) in path params. */
export function assertId(id: string): string {
  if (!/^[a-z0-9_-]{8,40}$/i.test(id)) throw new HttpProblem(400, 'invalid_id', 'Invalid id');
  return id;
}

/** Fastify's request logger is pino underneath; engines take a pino Logger. */
export function reqLog(req: FastifyRequest): Logger {
  return req.log as unknown as Logger;
}
