// Content-Security-Policy for the app renderer. Remote Iwara pages never run
// in the app renderer; they live in separate, isolated windows.
export function contentSecurityPolicy({ dev }: { dev: boolean }): string {
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "script-src": dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:", "blob:", "https://*.iwara.tv"],
    "font-src": ["'self'", "data:"],
    "connect-src": dev ? ["'self'", "ws://127.0.0.1:*", "http://127.0.0.1:*"] : ["'self'"],
    "media-src": ["'none'"],
    "object-src": ["'none'"],
    "base-uri": ["'none'"],
    "form-action": ["'none'"]
  };

  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}
