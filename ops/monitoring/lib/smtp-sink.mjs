// A mail server that accepts everything and keeps the messages, for the validation of the alert mail
// (ops/monitoring/validate.mjs). It speaks just enough SMTP for the Alertmanager: EHLO, MAIL, RCPT, DATA, QUIT.
// It offers no AUTH: Go refuses to send a password over a connection without TLS, so the Alertmanager skips it.
import { createServer } from "node:net";

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
        messages.push(state.message);
        state.message = "";
        socket.write("250 queued\r\n");
      } else {
        state.message += `${line}\n`;
      }
      end = state.buffer.indexOf("\r\n");
    }
  });
  socket.on("error", () => {});
}

/** Listens on every address (a container reaches it as host.docker.internal) and returns the port and the mail. */
export async function startSmtpSink() {
  const messages = [];
  const server = createServer((socket) => handleSocket(socket, messages));
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  return { port: server.address().port, messages, close: () => server.close() };
}
