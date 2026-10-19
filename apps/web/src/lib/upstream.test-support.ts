import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type Seen = Readonly<{
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}>;

export type Upstream = Readonly<{
  origin: string;
  seen: Seen[];
  /** Replaces how the next requests are answered. */
  answer: (handler: (request: Seen, response: ServerResponse) => void) => void;
  close: () => Promise<void>;
}>;

/** A real HTTP server on a free local port standing in for the API, recording every request it gets. */
export async function startUpstream(): Promise<Upstream> {
  const seen: Seen[] = [];
  let handler = (_request: Seen, response: ServerResponse): void => {
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      seen.push(entry);
      handler(entry, response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    answer: (next) => {
      handler = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
