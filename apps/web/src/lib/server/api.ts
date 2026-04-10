export async function fetchFromApi<T>(path: string, fetchImpl: typeof fetch): Promise<T> {
  const response = await fetchImpl(path);

  if (!response.ok) {
    throw new Error(`API request failed for ${path}: ${response.status}`);
  }

  return response.json() as Promise<T>;
}
