// The committed .mcp.json must start a working TestivAI MCP server: anyone
// who opens this repository in Claude Code (or another MCP client) gets it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('.mcp.json starts the TestivAI server with its review tools and prompt', async () => {
  const { mcpServers } = JSON.parse(fs.readFileSync(path.join(ROOT, '.mcp.json'), 'utf8'));
  const server = mcpServers.testivai;
  assert.ok(server, '.mcp.json defines a "testivai" server');
  assert.deepEqual(server.args, ['-y', '@testivai/mcp']);

  const client = new Client({ name: 'testivai-example-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args, cwd: ROOT, stderr: 'ignore' }));
  try {
    const listed = (await client.listTools()).tools;
    const tools = listed.map((t) => t.name);
    for (const name of ['get_visual_results', 'explain_snapshot', 'get_diff', 'approve_snapshot', 'approve_all']) {
      assert.ok(tools.includes(name), `missing tool ${name}`);
    }
    // The README promises a confirmation prompt on every approve call in
    // Claude Code; this marker is what asks for it. Read-only tools carry none.
    const asksUser = (name) => listed.find((t) => t.name === name)?._meta?.['anthropic/requiresUserInteraction'] === true;
    assert.ok(asksUser('approve_snapshot') && asksUser('approve_all'), 'approve tools must ask the user on every call');
    assert.ok(!asksUser('get_visual_results') && !asksUser('explain_snapshot'), 'read-only tools must not ask');
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    assert.ok(prompts.includes('review-visual-changes'));
  } finally {
    await client.close();
  }
});
