import type { RequestHandler } from './$types';

const API_BASE = process.env.HERMES_API_URL ?? 'http://127.0.0.1:4300';

const proxy: RequestHandler = async ({ params, request, url }) => {
  const target = new URL(`${API_BASE}/api/${params.path}`);
  url.searchParams.forEach((value, key) => {
    target.searchParams.append(key, value);
  });

  const init: RequestInit & { duplex?: 'half' } = {
    method: request.method,
    headers: new Headers(request.headers)
  };

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body;
    init.duplex = 'half';
  }

  const response = await fetch(target, init);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', headers.get('Cache-Control') ?? 'no-cache');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
};

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
