import { Client } from "pg";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Whether `connectionString` reaches this PC's server: the host pg itself will connect to, so a `?host=` parameter or
 * a socket path cannot hide another server behind a local-looking URL.
 */
export function isLocalServer(connectionString: string): boolean {
  const { host } = new Client({ connectionString });
  return LOCAL_HOSTS.has(host);
}
