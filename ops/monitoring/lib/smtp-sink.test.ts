import { networkInterfaces } from "node:os";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startSmtpSink } from "./smtp-sink.mjs";

const otherAddress = Object.values(networkInterfaces())
  .flat()
  .find((one) => one?.family === "IPv4" && !one.internal)?.address;

type Sink = Awaited<ReturnType<typeof startSmtpSink>>;

const open: Array<Sink | Socket> = [];

afterEach(() => {
  for (const one of open.splice(0)) {
    if ("destroy" in one) one.destroy();
    else one.close();
  }
});

async function sink(): Promise<Sink> {
  const started = await startSmtpSink();
  open.push(started);
  return started;
}

function client(port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1", () => resolve(socket));
    socket.resume();
    socket.on("error", reject);
    open.push(socket);
  });
}

const replies = (socket: Socket): string[] => {
  const seen: string[] = [];
  socket.on("data", (chunk) => seen.push(chunk.toString("utf8")));
  return seen;
};

const until = async (check: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !check(); tries += 1) {
    await new Promise((done) => setTimeout(done, 10));
  }
  expect(check()).toBe(true);
};

describe("the validation's mail sink", () => {
  // On Linux the sink listens on every address so a container reaches it through the bridge (smtp-sink.mjs).
  it.skipIf(otherAddress === undefined || process.platform === "linux")(
    "does not answer on the machine's other addresses",
    async () => {
      const started = await sink();
      const outcome = await new Promise<string>((resolve) => {
        const socket = connect(started.port, otherAddress);
        socket.on("error", (error) => resolve((error as NodeJS.ErrnoException).code ?? "error"));
        socket.on("connect", () => resolve("connected"));
        open.push(socket);
      });
      expect(outcome).toBe("ECONNREFUSED");
    },
  );

  it("answers on the loopback address", async () => {
    const started = await sink();
    const socket = await client(started.port);
    expect(socket.remoteAddress).toBe("127.0.0.1");
  });

  it("keeps a message sent through the SMTP dialogue", async () => {
    const started = await sink();
    const socket = await client(started.port);
    const seen = replies(socket);
    socket.write(
      "EHLO test\r\nMAIL FROM:<a@b>\r\nRCPT TO:<c@d>\r\nDATA\r\nSubject: hi\r\n\r\nbody\r\n.\r\nQUIT\r\n",
    );
    await until(() => started.messages.length === 1);
    expect(started.messages[0]).toBe("Subject: hi\n\nbody\n");
    await until(() => seen.join("").includes("221 bye"));
  });

  it("drops a connection that sends a line without an end past the cap", async () => {
    const started = await sink();
    const socket = await client(started.port);
    let closed = false;
    socket.on("close", () => {
      closed = true;
    });
    socket.write("x".repeat(70 * 1024));
    await until(() => closed);
    expect(started.messages).toEqual([]);
  });

  it("drops a connection whose message grows past the cap, and keeps nothing of it", async () => {
    const started = await sink();
    const socket = await client(started.port);
    let closed = false;
    socket.on("close", () => {
      closed = true;
    });
    socket.write("DATA\r\n");
    const line = `${"y".repeat(1000)}\r\n`;
    socket.write(line.repeat(1100));
    await until(() => closed);
    expect(started.messages).toEqual([]);
  });

  it("keeps at most 100 messages", async () => {
    const started = await sink();
    const socket = await client(started.port);
    const seen = replies(socket);
    const one = "DATA\r\nSubject: n\r\n\r\nbody\r\n.\r\n";
    socket.write(one.repeat(105));
    await until(() => seen.join("").split("250 queued").length - 1 === 105);
    expect(started.messages).toHaveLength(100);
  });
});
