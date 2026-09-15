/**
 * One way to talk to D1 from a pipeline script.
 *
 * Two scripts now write prospect addresses into the CRM — the loader that
 * carries them out of a sweep artifact, and the finder that starts from the
 * CRM rows themselves — and a second hand-rolled copy of this fetch is a
 * second place for the 403 message to go stale.
 *
 * That message is the reason this is worth sharing rather than repeating. The
 * token this repository uses was scoped for Pages and R2 for three weeks: it
 * authenticated perfectly and then refused every D1 call, and the generic
 * "403 Forbidden" that produced sent the next reader looking for a bug in the
 * query. Naming the missing permission in the error is what turned that into
 * a two-minute fix.
 */

export interface D1Row {
  [column: string]: unknown;
}

export type D1Query = <T = D1Row>(sql: string, params?: string[]) => Promise<T[]>;

export function makeD1(token: string, account: string, database: string): D1Query {
  return async <T = D1Row>(sql: string, params: string[] = []): Promise<T[]> => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${database}/query`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ sql, params }),
      },
    );
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      errors?: { code: number; message: string }[];
      result?: { results?: T[] }[];
    };
    if (!res.ok || body.success === false) {
      const why = (body.errors ?? []).map((e) => `${e.code} ${e.message}`).join('; ');
      if (res.status === 403 || res.status === 401) {
        throw new Error(
          `D1 ${res.status} — CLOUDFLARE_API_TOKEN cannot reach D1. It needs Account / D1 / Edit. (${why})`,
        );
      }
      throw new Error(`D1 ${res.status}${why ? ` — ${why}` : ''}`);
    }
    return body.result?.[0]?.results ?? [];
  };
}
