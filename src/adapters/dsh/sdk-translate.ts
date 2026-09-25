import type {
  ContentBlock,
  DeepSeekHarness,
  HarnessNotification,
} from '@deepseek-ai/dsh-sdk-client';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { AgentEvent } from '../types.js';
import { detectImageType } from '../../media/image-file.js';
import { EventChannel } from './event-channel.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeParseJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function textOfBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(isRecord)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
}

interface ToolDeltaTracker {
  emitted: Set<string>;
  /**
   * `${turn}:${step}` pairs that already streamed live chunk deltas. Newer dsh
   * runtimes stop emitting `assistant/chunk` and deliver the whole step in
   * `assistant/message`; the assistant-message translation then supplies the
   * text so those steps are not empty, while chunked steps keep the exact
   * streaming card and skip the duplicate content.
   */
  chunkedSteps?: Set<string>;
}

/** Identity of the step an assistant event belongs to, when the runtime labels it. */
function stepKey(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;
  const { turn, step } = data;
  if (typeof turn !== 'number' || typeof step !== 'number') return undefined;
  return `${String(turn)}:${String(step)}`;
}

function translateChunk(chunk: unknown, tracker: ToolDeltaTracker): AgentEvent[] {
  if (!isRecord(chunk)) return [];
  switch (chunk.type) {
    case 'reasoning-delta':
      return typeof chunk.text === 'string' && chunk.text
        ? [{ type: 'thinking', delta: chunk.text }]
        : [];
    case 'text-delta':
      return typeof chunk.text === 'string' && chunk.text
        ? [{ type: 'text', delta: chunk.text }]
        : [];
    case 'tool-call-delta': {
      const id = stringValue(chunk.id);
      if (!id || tracker.emitted.has(id)) return [];
      tracker.emitted.add(id);
      return [
        {
          type: 'tool_use',
          id,
          name: stringValue(chunk.name) ?? 'tool',
          input: {},
        },
      ];
    }
    default:
      return [];
  }
}

function translateToolResult(data: unknown): AgentEvent[] {
  if (!isRecord(data)) return [];
  const message = isRecord(data.message) ? data.message : undefined;
  const block = Array.isArray(message?.content) ? message.content[0] : undefined;
  const toolCallId = stringValue(
    isRecord(block) ? block.toolCallId : undefined,
  );
  if (!toolCallId) return [];
  const output = textOfBlocks(isRecord(block) ? block.content : undefined);
  const isError =
    data.error !== undefined || (isRecord(block) ? block.isError === true : false);
  return [
    {
      type: 'tool_result',
      id: toolCallId,
      output,
      isError,
    },
  ];
}

function translateUsage(usage: unknown): AgentEvent[] {
  if (!isRecord(usage)) return [];
  const inputTokens =
    typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined;
  const outputTokens =
    typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined;
  const cacheReadTokens =
    typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : undefined;
  const cacheWriteTokens =
    typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : undefined;
  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cacheReadTokens === undefined &&
    cacheWriteTokens === undefined
  ) return [];
  return [
    {
      type: 'usage',
      ...(inputTokens === undefined ? {} : { inputTokens }),
      ...(outputTokens === undefined ? {} : { outputTokens }),
      ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
      ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    },
  ];
}

/**
 * Content of one complete assistant message: reasoning blocks feed the
 * thinking section and the text blocks become the step's answer. Tool blocks
 * are skipped because `tool/call` / `tool/result` events already surface them,
 * which keeps the tool panel free of duplicates.
 */
function translateAssistantContent(message: unknown): AgentEvent[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return [];
  const events: AgentEvent[] = [];
  let text = '';
  for (const block of message.content) {
    if (!isRecord(block)) continue;
    if (block.type === 'reasoning' && typeof block.text === 'string' && block.text !== '') {
      events.push({ type: 'thinking', delta: block.text });
    } else if (block.type === 'text' && typeof block.text === 'string') {
      text += block.text;
    }
  }
  if (text.trim() !== '') events.push({ type: 'final_text', content: text });
  return events;
}

/**
 * Translate `assistant/message`. Steps that streamed live chunks keep their
 * streamed card (content is skipped, only usage is reported); steps without
 * chunks — the shape newer dsh runtimes emit — contribute their reasoning and
 * final text so the card is never empty.
 */
function translateAssistantMessage(data: unknown, tracker?: ToolDeltaTracker): AgentEvent[] {
  if (!isRecord(data)) return [];
  const key = stepKey(data);
  const chunked = key !== undefined && tracker?.chunkedSteps?.has(key) === true;
  const events: AgentEvent[] = chunked ? [] : translateAssistantContent(data.message);
  events.push(...translateUsage(data.usage));
  return events;
}

function translateTurnEnd(data: unknown): AgentEvent[] {
  if (!isRecord(data) || !isRecord(data.reason) || data.reason.kind !== 'error') return [];
  const failure = isRecord(data.reason.error) ? data.reason.error : undefined;
  const message = stringValue(failure?.message) ?? 'dsh turn failed';
  return [{ type: 'error', message, terminationReason: 'failed' }];
}

/**
 * Translate one SDK session event into bridge `AgentEvent`s.
 *
 * Two runtime shapes are supported. Runtimes that stream `assistant/chunk`
 * deltas keep the typewriter card: reasoning deltas feed the thinking section,
 * text deltas feed the output block, tool deltas surface live tool activity.
 * Runtimes that only append complete `assistant/message` events (dsh >= 0.1.5
 * stopped emitting chunk events on the session bus) instead contribute that
 * step's reasoning and final text, so the card still carries the answer; the
 * `chunkedSteps` tracker decides per step which of the two applies.
 */
export function translateSessionEvent(
  event: unknown,
  tracker: ToolDeltaTracker,
): AgentEvent[] {
  if (!isRecord(event) || typeof event.type !== 'string') return [];
  switch (event.type) {
    case 'assistant/chunk': {
      const data = isRecord(event.data) ? event.data : undefined;
      const events = translateChunk(data?.chunk, tracker);
      const key = stepKey(data);
      if (events.length > 0 && key !== undefined) {
        (tracker.chunkedSteps ??= new Set<string>()).add(key);
      }
      return events;
    }
    case 'tool/call': {
      const data = isRecord(event.data) ? event.data : undefined;
      const id = stringValue(data?.callId);
      if (!id) return [];
      return [
        {
          type: 'tool_use',
          id,
          name: stringValue(data?.name) ?? 'tool',
          input: safeParseJson(data?.arguments),
        },
      ];
    }
    case 'tool/result':
      return translateToolResult(event.data);
    case 'assistant/message':
      return translateAssistantMessage(event.data, tracker);
    case 'turn/end':
      return translateTurnEnd(event.data);
    default:
      return [];
  }
}

function translateNotification(
  notification: HarnessNotification,
  sessionId: string,
  tracker: ToolDeltaTracker,
): AgentEvent[] {
  if (notification.method !== 'session.event') return [];
  const params = isRecord(notification.params) ? notification.params : undefined;
  if (params?.sessionId !== sessionId) return [];
  return translateSessionEvent(params.event, tracker);
}

export interface SdkRunOptions {
  sessionId: string;
  cwd: string | undefined;
  model: string | undefined;
  images: readonly string[] | undefined;
  stopRequested: { value: boolean };
}

export interface SdkRunHandle {
  events: AsyncIterable<AgentEvent>;
  /** Resolves when the underlying SDK turn settles (success or failure). */
  settled: Promise<void>;
}

interface UploadedImageRef {
  attachmentId: string;
  mediaType: string;
  bytes: number;
  width: number;
  height: number;
  name?: string;
}

function uploadedImages(value: unknown, expected: number): UploadedImageRef[] {
  if (!isRecord(value) || !Array.isArray(value.attachments) || value.attachments.length !== expected) {
    throw new Error('dsh attachment upload returned an invalid response');
  }
  return value.attachments.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.attachmentId !== 'string' ||
      typeof item.mediaType !== 'string' ||
      typeof item.bytes !== 'number' ||
      typeof item.width !== 'number' ||
      typeof item.height !== 'number'
    ) {
      throw new Error('dsh attachment upload returned an invalid image reference');
    }
    return item as unknown as UploadedImageRef;
  });
}

async function buildPromptInput(
  harness: DeepSeekHarness,
  prompt: string,
  images: readonly string[] | undefined,
): Promise<string | ContentBlock[]> {
  if (!images?.length) return prompt;
  const encoded = await Promise.all(images.map(async (path) => {
    const [{ mediaType }, data] = await Promise.all([
      detectImageType(path),
      readFile(path),
    ]);
    return { mediaType, data: data.toString('base64'), name: basename(path) };
  }));
  await harness.start();
  const refs = uploadedImages(
    await harness.client.request('attachment/upload', { images: encoded }),
    encoded.length,
  );
  return [
    { type: 'text', text: prompt },
    ...refs.map((attachment) => ({ type: 'image', attachment }) as ContentBlock),
  ];
}

/**
 * Run one prompt on a harness session and stream the result as `AgentEvent`s.
 * The SDK client owns the runtime handshake; this helper owns the
 * notification-to-event translation and the run lifecycle.
 */
export function createSdkRun(
  harness: DeepSeekHarness,
  prompt: string,
  options: SdkRunOptions,
): SdkRunHandle {
  const channel = new EventChannel<AgentEvent>();
  const tracker: ToolDeltaTracker = { emitted: new Set() };
  let hadError = false;

  const runOptions = {
    sessionId: options.sessionId,
    onNotification: (notification: HarnessNotification) => {
      for (const event of translateNotification(notification, options.sessionId, tracker)) {
        if (event.type === 'error') hadError = true;
        channel.push(event);
      }
    },
  };
  // Preserve the SDK's synchronous run registration for text-only turns;
  // only image turns need the asynchronous upload admission first.
  const task = (options.images?.length
    ? buildPromptInput(harness, prompt, options.images)
      .then((input) => harness.run(input, runOptions))
    : harness.run(prompt, runOptions))
    .catch((error: unknown) => {
      if (!options.stopRequested.value) {
        channel.push({
          type: 'error',
          message: error instanceof Error ? error.message : String(error),
          terminationReason: 'failed',
        });
        hadError = true;
      }
    })
    .finally(() => {
      channel.close();
    });

  async function* events(): AsyncGenerator<AgentEvent> {
    yield {
      type: 'system',
      sessionId: options.sessionId,
      cwd: options.cwd,
      model: options.model,
    };
    for await (const event of channel) {
      yield event;
    }
    await task;
    if (!hadError) {
      yield {
        type: 'done',
        sessionId: options.sessionId,
        terminationReason: options.stopRequested.value ? 'interrupted' : 'normal',
      };
    }
  }

  return { events: events(), settled: task.then(() => undefined) };
}
