// Lokaler Mock der Claude Messages API (SSE) für Ende-zu-Ende-Tests ohne echten API-Schlüssel.
import http from 'node:http';

export function startMockAnthropic() {
  const requests = [];
  const opts = { rejectFallback: false, taskDelayMs: 0 };
  let n = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const json = JSON.parse(body || '{}');
      requests.push({ url: req.url, headers: req.headers, body: json });
      if (opts.rejectFallback && json.fallbacks) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'fallbacks: Extra inputs are not permitted' } }));
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      let closed = false;
      res.on('close', () => (closed = true));
      const send = (type, data) => !closed && res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const id = `msg_${++n}`;
      send('message_start', { message: { id, type: 'message', role: 'assistant', model: json.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      let idx = 0;
      const text = async (t, delay = 5) => {
        send('content_block_start', { index: idx, content_block: { type: 'text', text: '' } });
        for (const part of t.match(/.{1,12}/gs)) {
          send('content_block_delta', { index: idx, delta: { type: 'text_delta', text: part } });
          await sleep(delay);
        }
        send('content_block_stop', { index: idx++ });
      };
      const tool = (name, input) => {
        send('content_block_start', { index: idx, content_block: { type: 'tool_use', id: `toolu_${n}_${idx}`, name, input: {} } });
        send('content_block_delta', { index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
        send('content_block_stop', { index: idx++ });
      };
      const end = (reason) => {
        send('message_delta', { delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 20 } });
        send('message_stop', {});
        res.end();
      };

      const sys = json.system?.[0]?.text || '';
      const msgs = json.messages || [];
      const last = msgs[msgs.length - 1];
      const lastBlocks = Array.isArray(last?.content) ? last.content : [{ type: 'text', text: last?.content }];
      const toolResult = lastBlocks.find((b) => b.type === 'tool_result');
      const userText = lastBlocks.filter((b) => b.type === 'text' && !b.text.startsWith('[Kontext')).map((b) => b.text).join(' ');

      if (sys.startsWith('Du bist ein Hintergrund-Agent')) {
        await sleep(opts.taskDelayMs);
        await text('KURZFASSUNG: Die Robotik-Recherche ist fertig.\n\n# Bericht\n\nTestinhalt.');
        return end('end_turn');
      }
      if (toolResult) {
        const t = JSON.stringify(toolResult.content);
        if (t.includes('ECHO:')) await text(`Antwort vom Server: ${toolResult.content[0].text}.`);
        else if (t.includes('Jarvis Testseite')) await text('Die Seite heißt Jarvis Testseite.');
        else if (t.includes('task_')) await text('Ich kümmere mich darum.');
        else if (t.includes('abgelehnt')) await text('Verstanden, ich führe den Befehl nicht aus.');
        else if (t.includes('hallo')) await text('Der Befehl wurde ausgeführt.');
        else await text('Du hast heute keine offenen Aufgaben. Kann ich sonst etwas tun?');
        return end('end_turn');
      }
      if (/SYSTEM-EREIGNIS/.test(userText)) {
        await text('Die Recherche ist abgeschlossen.');
        return end('end_turn');
      }
      if (/heute an/i.test(userText)) {
        await text('Einen Moment, ich sehe nach. ');
        tool('todo_list', {});
        return end('tool_use');
      }
      if (/mcp echo/i.test(userText)) {
        tool('mcp__echo__echo', { text: 'hallo jarvis' });
        return end('tool_use');
      }
      if (/browser test/i.test(userText)) {
        tool('browser_open', { url: 'data:text/html,<title>Jarvis Testseite</title><h1>Hallo</h1>' });
        return end('tool_use');
      }
      if (/recherchiere/i.test(userText)) {
        tool('task_start', { title: 'Recherche: Robotik', instructions: 'Recherchiere Robotik-Investments.' });
        return end('tool_use');
      }
      if (/befehl/i.test(userText)) {
        tool('run_shell', { command: 'echo hallo', reason: 'Testbefehl' });
        return end('tool_use');
      }
      if (/erzähl/i.test(userText)) {
        await text('Das ist eine sehr lange Geschichte. Sie beginnt vor vielen Jahren in einer kleinen Werkstatt. Dort baute ein Erfinder seine erste Maschine. Sie konnte sprechen und denken. ' .repeat(4), 40);
        return end('end_turn');
      }
      await text(`Verstanden: ${userText}.`);
      end('end_turn');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests, opts })));
}
