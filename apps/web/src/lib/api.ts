export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export async function apiRequest<T>(getToken: () => Promise<string | null>, path: string, init: RequestInit = {}): Promise<T> {
  const token = await getToken();
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { message?: string | string[] } | null;
    const message = Array.isArray(payload?.message) ? payload.message.join(", ") : payload?.message;
    throw new Error(message || `Request failed with ${response.status}`);
  }
  return response.json() as Promise<T>;
}
