/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventEmitter } from 'events';
import net from 'net';

import * as z from 'zod';
import debug from 'debug';
import { makeSocketPath } from '@utils/fileUtils';
import { Context } from './context';
import { Response } from './response';
import { SessionLog } from './sessionLog';
import type { ContextConfig } from './context';
import type { IdleTimer } from './idleTimer';
import type * as playwright from '../../..';
import type { Tool } from './tool';
import type * as mcpServer from '../utils/mcp/server';
import type { ClientInfo, ServerBackend } from '../utils/mcp/server';
import type { ControlResult } from '../dashboard/dashboardController';

const backendDebug = debug('pw:mcp:backend');

export type BrowserBackendOptions = {
  dispose?: () => Promise<void>;
  idleTimer?: IdleTimer;
};

export class BrowserBackend extends EventEmitter<{ disconnected: [], dynamictoolschange: [] }> implements ServerBackend {
  private _tools: Tool[];
  private _context: Context | undefined;
  private _sessionLog: SessionLog | undefined;
  private _config: ContextConfig;
  private _disconnected = false;
  private _disposed = false;
  private _browserContext: playwright.BrowserContext;
  private _disposeCallback: (() => Promise<void>) | undefined;
  private _idleTimer: IdleTimer | undefined;

  constructor(config: ContextConfig, browserContext: playwright.BrowserContext, tools: Tool[], options: BrowserBackendOptions = {}) {
    super();
    this._config = config;
    this._tools = tools;
    this._browserContext = browserContext;
    this._disposeCallback = options.dispose;
    this._idleTimer = options.idleTimer;
    const markDisconnected = () => {
      if (this._disconnected)
        return;
      backendDebug('browser disconnected');
      this._disconnected = true;
      this.emit('disconnected');
    };
    this._browserContext.once('close', markDisconnected);
    this._browserContext.browser()?.once('disconnected', markDisconnected);
  }

  async initialize(clientInfo: ClientInfo): Promise<void> {
    this._sessionLog = this._config.saveSession ? await SessionLog.create(this._config, clientInfo.cwd) : undefined;
    this._context = new Context(this._browserContext, {
      config: this._config,
      sessionLog: this._sessionLog,
      cwd: clientInfo.cwd,
      onWebMCPToolsChanged: () => this.emit('dynamictoolschange'),
    });
  }

  dynamicTools(): mcpServer.Tool[] {
    return this._context?.currentWebMCPTools().map(tool => tool.schema) ?? [];
  }

  async dispose() {
    if (this._disposed)
      return;
    this._disposed = true;
    await this._context?.dispose().catch(e => debug('pw:tools:error')(e));
    await this._disposeCallback?.().catch(e => debug('pw:tools:error')(e));
  }

  async callTool(name: string, rawArguments: mcpServer.CallToolRequest['params']['arguments'] & { _meta?: Record<string, any> } = {}, signal?: AbortSignal): Promise<mcpServer.CallToolResult> {
    this._idleTimer?.poke();
    const json = !!rawArguments._meta?.json;
    const formatError = (message: string): mcpServer.CallToolResult => ({
      content: [{ type: 'text' as const, text: json ? JSON.stringify({ isError: true, error: message }, null, 2) : `### Error\n${message}` }],
      isError: true,
    });
    const context = this._context!;

    let parsedArguments: any;
    let handle: (params: any, response: Response) => Promise<void>;
    const tool = this._tools.find(tool => tool.schema.name === name);
    if (tool) {
      try {
        parsedArguments = tool.schema.inputSchema.parse(rawArguments);
      } catch (error) {
        if (error instanceof z.ZodError)
          return formatError(`Invalid arguments for tool "${name}":\n${z.prettifyError(error)}`);
        throw error;
      }
      handle = (params, response) => tool.handle(context, params, response, signal);
    } else {
      const webmcpTool = context.currentWebMCPTools().find(tool => tool.schema.name === name);
      if (!webmcpTool)
        return formatError(`Tool "${name}" not found`);
      // Page-registered WebMCP tools validate their own input, only strip the meta.
      parsedArguments = { ...rawArguments };
      delete parsedArguments._meta;
      handle = webmcpTool.handle;
    }

    const cwd = rawArguments._meta?.cwd;
    const raw = !!rawArguments._meta?.raw;
    const response = new Response(context, name, parsedArguments, { relativeTo: cwd, raw, json });
    context.setRunningTool(name);
    let responseObject: mcpServer.CallToolResult & { isClose?: boolean };
    try {
      const touchesPage = !tool || tool.schema.type === 'input' || tool.schema.type === 'action';
      const control: ControlResult = touchesPage ? await waitForDashboardControl(this._browserContext, signal) : { type: 'free' };
      if (signal?.aborted)
        return formatError('The command was cancelled while the user had control of the browser in the Playwright Dashboard.');
      if (control.type === 'released' && (control.message || control.actions.length))
        reportUserControl(control, response);
      else
        await handle(parsedArguments, response);
      for (const reason of context.drainPendingUnhandledRejections())
        response.addError(formatRejectionReason(reason));
      responseObject = await response.serialize();
      this._sessionLog?.logResponse(name, parsedArguments, responseObject);
    } catch (error: any) {
      const messages = [String(error), ...context.drainPendingUnhandledRejections().filter(reason => reason !== error).map(formatRejectionReason)];
      responseObject = formatError(messages.join('\n\n'));
    } finally {
      context.setRunningTool(undefined);
    }
    if (this._disconnected || responseObject.isClose) {
      delete responseObject.isClose;
      await this.dispose();
    }
    return responseObject;
  }
}

// The dashboard daemon replies when the user does not control the context. No dashboard means no user control.
async function waitForDashboardControl(browserContext: playwright.BrowserContext, signal?: AbortSignal): Promise<ControlResult> {
  // eslint-disable-next-line no-restricted-syntax -- _guid is the cross-process context identifier shared with the dashboard daemon.
  const contextGuid = (browserContext as any)._guid as string;
  return await new Promise<ControlResult>(resolve => {
    const socket = net.connect(makeSocketPath('dashboard', 'app'));
    const chunks: Buffer[] = [];
    const onAbort = () => socket.destroy();
    signal?.addEventListener('abort', onAbort);
    const done = (result: ControlResult) => {
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    socket.on('connect', () => socket.write(JSON.stringify({ waitForControl: contextGuid }) + '\n'));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', () => done({ type: 'free' }));
    socket.on('close', () => {
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString());
        done(result?.type === 'released' ? result : { type: 'free' });
      } catch {
        done({ type: 'free' });
      }
    });
  });
}

function reportUserControl(control: Extract<ControlResult, { type: 'released' }>, response: Response) {
  response.addError('The command was not run. The user took control of the browser in the Playwright Dashboard while the command was waiting. Read the message, the actions and the snapshot of the user, then decide the next step.');
  if (control.message)
    response.addTextResult(`Message from the user:\n${control.message}`);
  if (control.actions.length)
    response.addTextResult(`Actions of the user:\n${control.actions.map(action => `- ${action}`).join('\n')}`);
  response.setIncludeSnapshot();
}

function formatRejectionReason(reason: unknown): string {
  if (reason instanceof Error)
    return reason.stack ?? reason.message;
  return String(reason);
}
