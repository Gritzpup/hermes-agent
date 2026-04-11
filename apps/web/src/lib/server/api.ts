export async function fetchFromApi<T>(path: string, fetchImpl: typeof fetch, timeoutMs = 5000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(path, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`API request failed for ${path}: ${response.status}`);
    }
    return response.json() as Promise<T>;
  } finally {
    clearTimeout(timeout);
  }
}
