import { describe, expect, it } from 'bun:test';
import type { FetchLike } from '../ports';
import { ZernioClient, ZernioTransportError } from './client';

const SECRET_MARKER = 'secret-marker-api-key-and-proxy-password';

describe('Zernio transport diagnostics safety', () => {
  for (const code of ['ECONNRESET', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
    it(`${code} keeps its cause internally without exposing it in the message`, async () => {
      const cause = Object.assign(new Error(`${code}: ${SECRET_MARKER}`), { code });
      let calls = 0;
      const fetchImpl: FetchLike = Object.assign(async () => {
        calls += 1;
        throw cause;
      }, { preconnect: fetch.preconnect });
      const lines: string[] = [];
      const client = new ZernioClient({
        apiKey: SECRET_MARKER, fetchImpl, maxAttempts: 3,
        logger: (line) => lines.push(line),
      });
      let caught: unknown;
      try {
        await client.request('/posts', { method: 'POST', body: { content: 'hello' } });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ZernioTransportError);
      if (!(caught instanceof ZernioTransportError)) throw new Error('missing transport error');
      expect(caught.method).toBe('POST');
      expect(caught.path).toBe('/posts');
      expect(caught.name).toBe('ZernioTransportError');
      expect(caught.cause).toBe(cause);
      expect(caught.message).toContain('POST /posts');
      expect(caught.message).toContain('transport outcome unknown');
      expect(caught.message).not.toContain(SECRET_MARKER);
      expect(String(caught)).not.toContain(SECRET_MARKER);
      expect(JSON.stringify(lines)).not.toContain(SECRET_MARKER);
      expect(calls).toBe(1);
    });
  }
});
