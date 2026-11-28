'use strict';

// The far end of the wire: it decodes what arrives and sends the envelope straight back; what it
// cannot decode it drops, exactly as the real agent drops it. The sender then sees silence with
// the next message still coming through — which is all the host can observe of a live agent.
//
// The same file is the entry of a real forked child, so the contract runs over a genuine process
// boundary as well as over an in-process pair. It writes nothing to stdout: its log goes to the
// recorder handed to the codec, as the agent's does.

const { createCodec } = require('../../src/main/platform/agent/protocol');
const { nodeIpcTransport } = require('../../src/main/platform/agent/transport/node-ipc');

function echoOn(transport) {
  const lines = [];
  const log = {};
  for (const level of ['debug', 'info', 'warn', 'error']) log[level] = (msg) => lines.push([level, msg]);
  const codec = createCodec({ log });
  transport.onMessage((raw) => {
    const msg = codec.read(raw);
    if (msg) transport.send(msg);
  });
  return { codec, lines };
}

module.exports = { echoOn };

if (require.main === module) echoOn(nodeIpcTransport(process));
