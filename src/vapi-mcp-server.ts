/**
 * GoHighLevel MCP — Vapi / Railway-friendly HTTP surface
 *
 * Mirrors rapidleadspromcp-all: root POST `/` (JSON-RPC), OAuth stubs,
 * `/mcp` streamable HTTP, `/sse` SSE, permissive CORS for hosted MCP clients.
 *
 * Tool execution uses the same stack as main.ts: EnhancedGHLClient +
 * ToolRegistry + MCPAppsManager.
 */

import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { EnhancedGHLClient } from './enhanced-ghl-client.js';
import { ToolRegistry } from './tool-registry.js';
import { MCPAppsManager } from './apps/index.js';
import { GHLConfig } from './types/ghl-types.js';

dotenv.config();

class VapiMCPServer {
  private app: express.Application;
  private ghlClient: EnhancedGHLClient;
  private registry: ToolRegistry;
  private appsManager: MCPAppsManager;
  private port: number;
  private streamableSessions = new Map<string, StreamableHTTPServerTransport>();

  constructor() {
    this.port = parseInt(process.env.PORT || process.env.VAPI_MCP_PORT || '3000', 10);
    console.log(`[Vapi MCP] PORT=${this.port} (PORT=${process.env.PORT ?? ''} VAPI_MCP_PORT=${process.env.VAPI_MCP_PORT ?? ''})`);

    this.app = express();
    this.ghlClient = this.initializeGHLClient();
    this.registry = new ToolRegistry(this.ghlClient);
    this.appsManager = new MCPAppsManager(this.ghlClient);

    this.setupExpress();
    this.setupRoutes();
  }

  private initializeGHLClient(): EnhancedGHLClient {
    const config: GHLConfig = {
      accessToken: process.env.GHL_API_KEY || '',
      baseUrl: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
      version: '2021-07-28',
      locationId: process.env.GHL_LOCATION_ID || '',
    };
    if (!config.accessToken) throw new Error('GHL_API_KEY environment variable is required');
    if (!config.locationId) throw new Error('GHL_LOCATION_ID environment variable is required');
    return new EnhancedGHLClient(config);
  }

  private setupExpress(): void {
    this.app.use(
      cors({
        origin: '*',
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Content-Type',
          'Authorization',
          'Accept',
          'Mcp-Session-Id',
          'X-Call-Id',
          'X-Chat-Id',
          'X-Session-Id',
        ],
        credentials: false,
      })
    );

    this.app.use((req, res, next) => {
      const isSSEPost =
        req.method === 'POST' && (req.path === '/sse' || req.path === '/elevenlabs');
      if (isSSEPost) return next();
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        express.urlencoded({ extended: false })(req, res, next);
      } else {
        express.json({ limit: '10mb' })(req, res, next);
      }
    });

    this.app.use((req, _res, next) => {
      console.log(`[Vapi MCP] ${req.method} ${req.path}`);
      next();
    });
  }

  private getAllToolDefinitions() {
    return this.registry.getAllToolDefinitions(this.appsManager.getToolDefinitions());
  }

  /** Same policy as rapidleadspromcp-all: hide delete_contact for safer defaults */
  private getFilteredToolDefinitions() {
    return this.getAllToolDefinitions().filter((t) => t.name !== 'delete_contact');
  }

  private async executeToolCall(name: string, args: Record<string, unknown>) {
    if (this.appsManager.isAppTool(name)) {
      return await this.appsManager.executeTool(name, args || {});
    }
    const result = await this.registry.callTool(name, args || {});
    if (result === undefined) throw new Error(`Unknown tool: ${name}`);
    return result;
  }

  private createMCPServer(): Server {
    const server = new Server(
      { name: 'ghl-mcp-server', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.getAllToolDefinitions(),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        const result = await this.executeToolCall(name, (args || {}) as Record<string, unknown>);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    });

    return server;
  }

  private setupRoutes(): void {
    const SERVER_URL = process.env.SERVER_URL || `http://localhost:${this.port}`;
    const OAUTH_SECRET = process.env.OAUTH_SECRET || 'mcp-server-secret-change-me';

    this.app.get('/.well-known/oauth-authorization-server', (_req, res) => {
      res.json({
        issuer: SERVER_URL,
        authorization_endpoint: `${SERVER_URL}/authorize`,
        token_endpoint: `${SERVER_URL}/token`,
        registration_endpoint: `${SERVER_URL}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'client_credentials'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['mcp'],
      });
    });

    this.app.post('/register', (req, res) => {
      const clientId = randomUUID();
      res.status(201).json({
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: req.body?.redirect_uris || [],
        grant_types: ['authorization_code', 'client_credentials'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
    });

    this.app.get('/authorize', (req, res) => {
      const { redirect_uri, state, code_challenge } = req.query as Record<string, string>;
      const code = Buffer.from(
        JSON.stringify({ ts: Date.now(), challenge: code_challenge || '' })
      ).toString('base64url');
      if (!redirect_uri) {
        res.status(400).json({ error: 'redirect_uri required' });
        return;
      }
      const url = new URL(redirect_uri);
      url.searchParams.set('code', code);
      if (state) url.searchParams.set('state', state);
      res.redirect(url.toString());
    });

    this.app.post('/token', (req, res) => {
      const body = req.body || {};
      const grantType = body.grant_type;
      if (grantType !== 'authorization_code' && grantType !== 'client_credentials') {
        res.status(400).json({ error: 'unsupported_grant_type' });
        return;
      }
      const payload = { iss: SERVER_URL, iat: Math.floor(Date.now() / 1000), scope: 'mcp' };
      const token =
        Buffer.from(JSON.stringify(payload)).toString('base64url') +
        '.' +
        Buffer.from(OAUTH_SECRET).toString('base64url');
      res.json({
        access_token: token,
        token_type: 'Bearer',
        expires_in: 86400,
        scope: 'mcp',
      });
    });

    this.app.get('/health', async (_req, res) => {
      try {
        const testResponse = await this.ghlClient.getLocationById(this.ghlClient.getConfig().locationId);
        const appCount = this.appsManager.getToolDefinitions().length;
        res.json({
          status: 'healthy',
          server: 'ghl-mcp-server-vapi',
          version: '2.0.0',
          timestamp: new Date().toISOString(),
          protocol: 'streamable-http+jsonrpc-root',
          tools: this.registry.getToolCounts(appCount),
          ghl: {
            connected: testResponse.success,
            locationId: this.ghlClient.getConfig().locationId,
            locationName: testResponse.data?.location?.name || 'Unknown',
            baseUrl: this.ghlClient.getConfig().baseUrl,
          },
        });
      } catch (error) {
        res.status(500).json({
          status: 'unhealthy',
          server: 'ghl-mcp-server-vapi',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    });

    this.app.get('/', (_req, res) => {
      const appCount = this.appsManager.getToolDefinitions().length;
      res.json({
        name: 'GoHighLevel MCP Server (Vapi/Railway)',
        version: '2.0.0',
        status: 'running',
        endpoints: {
          health: '/health',
          mcpStreamable: '/mcp',
          sse: '/sse',
          jsonRpcRoot: 'POST /',
        },
        tools: this.registry.getToolCounts(appCount),
      });
    });

    this.app.post('/', async (req, res) => {
      const method = req.body?.method;
      if (!method) {
        res.json({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request - no method specified' },
        });
        return;
      }

      if (method === 'initialize') {
        const clientVersion = req.body?.params?.protocolVersion || '2024-11-05';
        const supported = ['2024-11-05', '2025-03-26'];
        const protocolVersion = supported.includes(clientVersion) ? clientVersion : '2024-11-05';
        res.json({
          jsonrpc: '2.0',
          id: req.body?.id !== undefined ? req.body.id : 1,
          result: {
            protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'ghl-mcp-server', version: '2.0.0' },
          },
        });
        return;
      }

      if (method === 'initialized' || method === 'notifications/initialized') {
        res.status(200).send();
        return;
      }

      if (method === 'tools/list') {
        const tools = this.getFilteredToolDefinitions();
        res.json({
          jsonrpc: '2.0',
          id: req.body?.id ?? 1,
          result: { tools },
        });
        return;
      }

      if (method === 'tools/call') {
        const { name, arguments: args } = req.body?.params || {};
        try {
          const result = await this.executeToolCall(name, args || {});
          res.json({
            jsonrpc: '2.0',
            id: req.body?.id ?? 1,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
            },
          });
        } catch (error) {
          res.status(500).json({
            jsonrpc: '2.0',
            id: req.body?.id ?? 1,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Tool execution failed',
            },
          });
        }
        return;
      }

      res.status(400).json({
        jsonrpc: '2.0',
        id: req.body?.id ?? 1,
        error: { code: -32601, message: `Unknown method: ${method}` },
      });
    });

    this.app.post('/mcp/initialize', (req, res) => {
      const clientVersion = req.body?.params?.protocolVersion || '2024-11-05';
      const supported = ['2024-11-05', '2025-03-26'];
      const protocolVersion = supported.includes(clientVersion) ? clientVersion : '2024-11-05';
      res.json({
        jsonrpc: '2.0',
        id: req.body?.id ?? 1,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'ghl-mcp-server', version: '2.0.0' },
        },
      });
    });

    this.app.post('/mcp/tools/list', (req, res) => {
      try {
        const tools = this.getFilteredToolDefinitions();
        res.json({ jsonrpc: '2.0', id: req.body?.id ?? 1, result: { tools } });
      } catch (error) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id ?? 1,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Failed to list tools',
          },
        });
      }
    });

    this.app.post('/mcp/tools/call', async (req, res) => {
      const { name, arguments: args } = req.body?.params || {};
      try {
        const result = await this.executeToolCall(name, args || {});
        res.json({
          jsonrpc: '2.0',
          id: req.body?.id ?? 1,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        });
      } catch (error) {
        res.status(500).json({
          jsonrpc: '2.0',
          id: req.body?.id ?? 1,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : 'Tool execution failed',
          },
        });
      }
    });

    this.app.get('/mcp/tools/list', (_req, res) => {
      try {
        const tools = this.getAllToolDefinitions();
        res.json({ tools, count: tools.length });
      } catch {
        res.status(500).json({ error: 'Failed to list tools' });
      }
    });

    this.app.all('/debug', (req, res) => {
      res.json({
        method: req.method,
        headers: req.headers,
        query: req.query,
        body: req.body,
        timestamp: new Date().toISOString(),
      });
    });

    const sseTransports = new Map<string, SSEServerTransport>();
    const sseByIndex = new Map<number, SSEServerTransport>();
    let sseIndex = 0;

    this.app.get('/sse', async (req, res) => {
      const idx = sseIndex++;
      try {
        const mcpServer = this.createMCPServer();
        const transport = new SSEServerTransport('/sse', res);
        await mcpServer.connect(transport);
        const sdkSessionId = transport.sessionId;
        sseTransports.set(sdkSessionId, transport);
        sseByIndex.set(idx, transport);
        if (req.ip) sseTransports.set(`ip:${req.ip}`, transport);
        req.on('close', () => {
          sseTransports.delete(sdkSessionId);
          sseByIndex.delete(idx);
          if (req.ip) sseTransports.delete(`ip:${req.ip}`);
        });
      } catch (err) {
        console.error('[SSE MCP] Setup error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'SSE setup failed' });
        else res.end();
      }
    });

    this.app.post('/sse', async (req, res) => {
      const sessionId = (req.query.sessionId as string) || 'unknown';
      const transport =
        sseTransports.get(sessionId) ??
        (req.ip ? sseTransports.get(`ip:${req.ip}`) : undefined) ??
        (sseByIndex.size > 0 ? sseByIndex.get(Math.max(...Array.from(sseByIndex.keys()))) : undefined);
      if (!transport) {
        res.status(404).json({ error: 'SSE session not found' });
        return;
      }
      try {
        await transport.handlePostMessage(req, res);
      } catch (err) {
        console.error('[SSE MCP] handlePostMessage error:', err);
        if (!res.headersSent) res.status(500).json({ error: 'Message handling failed' });
      }
    });

    this.app.get('/elevenlabs', async (req, res) => {
      const idx = sseIndex++;
      try {
        const mcpServer = this.createMCPServer();
        const transport = new SSEServerTransport('/elevenlabs', res);
        await mcpServer.connect(transport);
        const sdkSessionId = transport.sessionId;
        sseTransports.set(sdkSessionId, transport);
        sseByIndex.set(idx, transport);
        if (req.ip) sseTransports.set(`ip:${req.ip}`, transport);
        req.on('close', () => {
          sseTransports.delete(sdkSessionId);
          sseByIndex.delete(idx);
          if (req.ip) sseTransports.delete(`ip:${req.ip}`);
        });
      } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: 'SSE setup failed' });
        else res.end();
      }
    });

    this.app.post('/elevenlabs', async (req, res) => {
      const sessionId = (req.query.sessionId as string) || 'unknown';
      const transport =
        sseTransports.get(sessionId) ??
        (req.ip ? sseTransports.get(`ip:${req.ip}`) : undefined) ??
        (sseByIndex.size > 0 ? sseByIndex.get(Math.max(...Array.from(sseByIndex.keys()))) : undefined);
      if (!transport) {
        res.status(404).json({ error: 'SSE session not found' });
        return;
      }
      try {
        await transport.handlePostMessage(req, res);
      } catch (err) {
        if (!res.headersSent) res.status(500).json({ error: 'Message handling failed' });
      }
    });

    this.app.post('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport: StreamableHTTPServerTransport;

      if (sessionId && this.streamableSessions.has(sessionId)) {
        transport = this.streamableSessions.get(sessionId)!;
      } else if (!sessionId) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            console.log(`[Streamable-HTTP MCP] Session initialized: ${sid}`);
            this.streamableSessions.set(sid, transport);
          },
          onsessionclosed: (sid) => {
            console.log(`[Streamable-HTTP MCP] Session closed: ${sid}`);
            this.streamableSessions.delete(sid);
          },
        });
        const mcpServer = this.createMCPServer();
        await mcpServer.connect(transport);
      } else {
        res.status(400).json({ error: 'Invalid or expired session ID' });
        return;
      }

      await transport.handleRequest(req, res);
    });

    this.app.get('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId || !this.streamableSessions.has(sessionId)) {
        res.status(400).json({ error: 'Valid Mcp-Session-Id header required' });
        return;
      }
      await this.streamableSessions.get(sessionId)!.handleRequest(req, res);
    });

    this.app.delete('/mcp', async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && this.streamableSessions.has(sessionId)) {
        await this.streamableSessions.get(sessionId)!.handleRequest(req, res);
      } else {
        res.status(404).json({ error: 'Session not found' });
      }
    });
  }

  async start(): Promise<void> {
    await this.ghlClient.testConnection();
    this.app.listen(this.port, '0.0.0.0', () => {
      console.log('✅ Vapi/Railway MCP server listening');
      console.log(`   http://0.0.0.0:${this.port}/`);
      console.log(`   Streamable HTTP: POST ${this.port}/mcp`);
      console.log(`   SSE: GET ${this.port}/sse`);
    });
  }
}

function setupGracefulShutdown(): void {
  const shutdown = (signal: string) => {
    console.log(`\n[Vapi MCP] ${signal}, exiting`);
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

async function main(): Promise<void> {
  setupGracefulShutdown();
  const server = new VapiMCPServer();
  await server.start();
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
