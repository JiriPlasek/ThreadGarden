// A minimal stdio MCP server for the opt-in real tests: newline-delimited JSON-RPC,
// one `echo` tool, no dependencies beyond node:readline.
import readline from 'node:readline';

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.id === undefined) return; // notifications (initialized, cancelled) need no answer
  switch (m.method) {
    case 'initialize':
      send({
        id: m.id,
        result: {
          protocolVersion: m.params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'echo-fixture', version: '0.0.1' },
        },
      });
      break;
    case 'tools/list':
      send({
        id: m.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Returns the text it is given.',
              inputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
              },
            },
          ],
        },
      });
      break;
    case 'tools/call':
      send({
        id: m.id,
        result: { content: [{ type: 'text', text: String(m.params?.arguments?.text ?? '') }] },
      });
      break;
    case 'ping':
      send({ id: m.id, result: {} });
      break;
    default:
      send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
  }
});
rl.on('close', () => process.exit(0));
