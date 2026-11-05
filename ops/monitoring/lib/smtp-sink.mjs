// A mail server that accepts everything and keeps the messages, for the validation of the alert mail
// (ops/monitoring/validate.mjs). It speaks just enough SMTP for the Alertmanager: EHLO, MAIL, RCPT, DATA, QUIT.
// It offers no AUTH: Go refuses to send a password over a connection without TLS, so the Alertmanager skips it.
import { createServer } from "node:net";

// The sink holds what a validation run sends it and nothing more: a line, a message and the list of messages are
// capped, and a connection that passes a cap is dropped.
const MAX_LINE_BYTES = 64 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_MESSAGES = 100;

function handleLine(socket, state, line) {
  const command = line.slice(0, 4).toUpperCase();
  if (command === "EHLO" || command === "HELO") {
    socket.write("250 sink\r\n");
  } else if (command === "AUTH") {
    socket.write("235 2.7.0 accepted\r\n");
  } else if (command === "DATA") {
    state.inData = true;
    socket.write("354 end with a lone dot\r\n");
  } else if (command === "QUIT") {
    socket.end("221 bye\r\n");
  } else {
    socket.write("250 ok\r\n");
  }
}

function handleSocket(socket, messages) {
  const state = { inData: false, buffer: "", message: "" };
  socket.write("220 sink ESMTP\r\n");
  socket.on("data", (chunk) => {
    state.buffer += chunk.toString("utf8");
    let end = state.buffer.indexOf("\r\n");
    while (end >= 0) {
      const line = state.buffer.slice(0, end);
      state.buffer = state.buffer.slice(end + 2);
      if (!state.inData) {
        handleLine(socket, state, line);
      } else if (line === ".") {
        state.inData = false;
        if (messages.length < MAX_MESSAGES) messages.push(state.message);
        state.message = "";
        socket.write("250 queued\r\n");
      } else {
        state.message += `${line}\n`;
      }
      end = state.buffer.indexOf("\r\n");
    }
    if (state.buffer.length > MAX_LINE_BYTES || state.message.length > MAX_MESSAGE_BYTES) {
      socket.destroy();
    }
  });
  socket.on("error", () => {});
}

const LISTEN_HOST = process.platform === "linux" ? "0.0.0.0" : "127.0.0.1";

/**
 * Listens and returns the port and the mail. A container reaches it as host.docker.internal: on Docker Desktop (Windows,
 * macOS) that arrives from the machine itself, so 127.0.0.1 is enough; Docker Engine on Linux resolves the name to its
 * bridge address, so there it listens on every address (the buffers are capped and the run is short-lived).
 */
export async function startSmtpSink() {
  const messages = [];
  const server = createServer((socket) => handleSocket(socket, messages));
  await new Promise((resolve) => server.listen(0, LISTEN_HOST, resolve));
  return { port: server.address().port, messages, close: () => server.close() };
}
