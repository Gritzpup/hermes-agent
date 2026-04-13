import type { RequestHandler } from './$types';

const API_BASE_CANDIDATES = [
  process.env.HERMES_API_URL,
  'http://127.0.0.1:4300',
  'http://localhost:4300',
  'http://host.docker.internal:4300'
].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

function buildForwardHeaders(request: Request): Headers {
  const headers = new Headers();
  const allowed = [
    'accept',
    'authorization',
    'content-type',
    'if-none-match',
    'if-modified-since',
    'cache-control'
  ];

  for (const name of allowed) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  return headers;
}

function sanitizeProxyResponseHeaders(source: Headers): Headers {
  const headers = new Headers(source);

  for (const name of [
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'connection',
    'keep-alive'
  ]) {
    headers.delete(name);
  }

  return headers;
}

const proxy: RequestHandler = async ({ params, request, url }) => {
  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: buildForwardHeaders(request)
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  let lastError: unknown = null;

  for (const base of API_BASE_CANDIDATES) {
    const target = new URL(`/api/${params.path}`, base);
    url.searchParams.forEach((value, key) => {
      target.searchParams.append(key, value);
    });

    try {
      const response = await fetch(target, init);
      const headers = sanitizeProxyResponseHeaders(response.headers);
      headers.set('Cache-Control', headers.get('Cache-Control') ?? 'no-cache');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers
      });
    } catch (error) {
      lastError = error;
    }
  }

  return Response.json({
    error: 'proxy_unreachable',
    path: params.path,
    detail: lastError instanceof Error ? lastError.message : 'unknown fetch failure'
  }, { status: 502 });
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
